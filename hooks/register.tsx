import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Job } from '../types'

type BashBackground = {
  stdout?: string
  backgroundTaskId?: string
  backgroundOutputPath?: string
}

const PANE = 'bg-watch'
const POLL_MS = 3000
const KEEP_JOBS = 20
const KEEP_AGENTS = 40

// Bump a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'bg-watch', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const agents = atom({ plugin: 'bg-watch', key: 'agents' } as const, [], {
  shape: 'agents-1',
})

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const shortModel = (model: string) => model.replace(/^claude-/, '')

/** The output file the Bash tool names in its background reply. */
const outputPathOf = (stdout: string, fallback?: string) =>
  /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(stdout)?.[1] ?? fallback ?? ''

/** Progress, failures and the last line, read off the output text. */
const digest = (text: string) => {
  const tail = text.slice(-64 * 1024)
  const ratios = [...tail.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)]
  const last = ratios.at(-1)
  const lines = tail.split('\n').map(line => line.trimEnd())
  const lastLine = [...lines].reverse().find(line => line.trim() !== '') ?? ''
  return {
    progress: last ? `${last[1]}/${last[2]}` : undefined,
    failures: (text.match(/^\s*not ok\b/gm) ?? []).length,
    lastLine: clip(lastLine.trim(), 160),
  }
}

/** `<task-id>` and `<status>` of a task notification's text. */
const notificationOf = (text: string) => {
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim()
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim()
  return id && status ? { id, status } : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bg-watch',
      description: 'Open the background jobs & subagents pane; "close" closes it, "clear" drops finished rows',
    })

    $.clock.every(POLL_MS, async () => {
      const list = await read($, jobs)
      const running = list.filter(job => job.status === 'running' && job.path)
      if (running.length === 0) return
      const now = await $.clock.now()
      const seen = new Map<string, Partial<Job>>()
      for (const job of running) {
        try {
          const text = await $.fs.read(job.path)
          const bytes = text.length
          seen.set(job.id, {
            ...digest(text),
            bytes,
            updatedAt: bytes !== job.bytes ? now : job.updatedAt,
          })
        } catch {
          // Missing or over 4 MiB: keep the last reading; the row shows its age.
        }
      }
      if (seen.size > 0) {
        await update($, jobs, all =>
          all.map(job => (seen.has(job.id) ? { ...job, ...seen.get(job.id) } : job)),
        )
      }
      await showStatus($)
    })

    return next(e)
  })

  on('command.run', { command: 'bg-watch' }, async ($, e) => {
    if (/\bclear\b/.test(e.args)) {
      await update($, jobs, all => all.filter(job => job.status === 'running'))
      await update($, agents, () => [])
      await showStatus($)
      return { text: 'bg-watch: finished jobs and agent rows cleared.' }
    }
    if (/\bclose\b/.test(e.args)) {
      await $.ui.close({ id: PANE })
      return { text: 'bg-watch pane closed (status line keeps running).' }
    }
    await $.ui.open({ id: PANE, title: 'Background & agents' })
    return { text: 'bg-watch pane opened.' }
  })

  // A background Bash call: remember its task id and output file.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const ran = await next(e)
    // The Bash record's background fields (claude-code-tools' Bash result).
    const result = ran.result as BashBackground | undefined
    if (ran.deny !== undefined || !result?.backgroundTaskId) return ran
    const now = await $.clock.now()
    const job: Job = {
      id: result.backgroundTaskId,
      command: clip(e.command.replace(/\s+/g, ' ').trim(), 120),
      description: clip(e.description ?? '', 80),
      path: outputPathOf(result.stdout ?? '', result.backgroundOutputPath),
      startedAt: now,
      updatedAt: now,
      status: 'running',
      bytes: 0,
      failures: 0,
      lastLine: '',
    }
    await update($, jobs, all => [...all.filter(one => one.id !== job.id), job].slice(-KEEP_JOBS))
    await showStatus($)
    return ran
  }).catch(($, e, next) => next(e))

  // The end of a background task arrives as a task notification.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const note = notificationOf(e.text)
      if (note) {
        const now = await $.clock.now()
        let ended: Job | undefined
        await update($, jobs, all =>
          all.map(job => {
            if (job.id !== note.id || job.status !== 'running') return job
            ended = { ...job, status: note.status, endedAt: now }
            return ended
          }),
        )
        if (ended) {
          const mark = ended.status === 'completed' ? '✓' : '✗'
          $.ui.toast(
            `${mark} ${clip(ended.description || ended.command, 50)} ${ended.status} (${elapsed(now - ended.startedAt)})`,
          )
          await showStatus($)
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every model request, main's or a subagent's: what was actually sent.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? 'main'
    const effort = e.effort === undefined ? '-' : String(e.effort)
    void $.clock.now().then(now =>
      update($, agents, all => {
        const old = all.find(row => row.id === id)
        const row: AgentRow = {
          id,
          model: e.model,
          effort,
          steps: (old?.steps ?? 0) + 1,
          firstAt: old?.firstAt ?? now,
          lastAt: now,
        }
        return [...all.filter(one => one.id !== id), row].slice(-KEEP_AGENTS)
      }),
    )
    return yield* next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [jobList, agentList, roster, now] = await Promise.all([
      read($, jobs),
      read($, agents),
      $.agent.list().catch(() => []),
      $.clock.now(),
    ])
    const info = new Map(roster.map(one => [one.id, one]))
    const subagents = agentList.filter(row => row.id !== 'main')
    const main = agentList.find(row => row.id === 'main')
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 8)
    const jobRows = jobList.slice(-Math.ceil(room / 3))
    const agentRows = subagents.slice(-Math.max(2, room - jobRows.length * 2))

    return (
      <Box flexDirection="column">
        <Text bold>Background jobs</Text>
        {jobRows.length === 0 && <Text dimColor>  none yet</Text>}
        {jobRows.map(job => {
          const end = job.endedAt ?? now
          const stale = job.status === 'running' && now - job.updatedAt > 60_000
          const head =
            job.status === 'running' ? '▶' : job.status === 'completed' ? '✓' : '✗'
          return (
            <Box flexDirection="column">
              <Text color={job.status === 'running' ? undefined : job.status === 'completed' ? 'green' : 'red'}>
                {head} {clip(job.description || job.command, 48)}
                {job.progress ? `  ${job.progress}` : ''}
                {job.failures > 0 ? `  not ok ×${job.failures}` : ''}
                {`  ${elapsed(end - job.startedAt)}`}
                {stale ? `  (quiet ${elapsed(now - job.updatedAt)})` : ''}
              </Text>
              {job.status === 'running' && job.lastLine !== '' && (
                <Text dimColor>    {clip(job.lastLine, 100)}</Text>
              )}
            </Box>
          )
        })}
        <Text> </Text>
        <Text bold>
          Subagents (actual model@effort)
          {main ? `   main: ${shortModel(main.model)}@${main.effort}` : ''}
        </Text>
        {agentRows.length === 0 && <Text dimColor>  none yet</Text>}
        {agentRows.map(row => {
          const one = info.get(row.id)
          const status = one?.status ?? '?'
          return (
            <Text dimColor={status !== 'running'}>
              {status === 'running' ? '▶' : '·'} {clip(one?.type ?? row.id, 22).padEnd(22)}{' '}
              {clip(one?.description ?? '', 28).padEnd(28)} {shortModel(row.model)}@{row.effort}
              {`  ${row.steps} steps  ${elapsed(row.lastAt - row.firstAt)}`}
            </Text>
          )
        })}
      </Box>
    )
  })
}

/** One status-line entry for running jobs, cleared when none run. */
async function showStatus($: EngineInterface) {
  const list = await read($, jobs)
  const now = await $.clock.now()
  const running = list.filter(job => job.status === 'running')
  if (running.length === 0) {
    $.ui.status(undefined)
    return
  }
  const first = running[0]!
  const more = running.length > 1 ? ` +${running.length - 1}` : ''
  $.ui.status(
    `▶ ${clip(first.description || first.command, 30)}${first.progress ? ` ${first.progress}` : ''} · ${elapsed(now - first.startedAt)}${more}`,
  )
}
