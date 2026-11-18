import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { AgentRow, Job, JobKind } from '../types'
import { clip, elapsed, notificationOf, outputPathOf, readPiece, tasksDirOf, tokens } from './parse'

type BashBackground = {
  stdout?: string
  backgroundTaskId?: string
  backgroundOutputPath?: string
}

const PANE = 'bg-watch'
const POLL_MS = 3000
const KEEP_JOBS = 20
const KEEP_AGENTS = 40
/** How often one quiet job is asked about. */
const RELEASE_CHECK_EVERY_MS = 9_000
/** Output file missing this long after start: the job is gone. */
const MISSING_GRACE_MS = 30_000
/** A Monitor this long past its deadline with no notification: expired. */
const DEADLINE_GRACE_MS = 30_000
/** Most bytes read from an output file in one poll (the newest ones). */
const READ_MAX = 256 * 1024

/** The `userConfig` fields, as numbers in milliseconds where they are times. */
type Config = {
  finishedTtlMs: number
  quietCheckMs: number
  staleMs: number
  notifyAfterMs: number
  statusLine: boolean
}

const DEFAULTS: Config = {
  finishedTtlMs: 180_000,
  quietCheckMs: 10_000,
  staleMs: 60_000,
  notifyAfterMs: 120_000,
  statusLine: true,
}

const seconds = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1000 : fallback

const configOf = (options: PluginOptions | undefined): Config => ({
  finishedTtlMs: seconds(options?.finishedTtlSec, DEFAULTS.finishedTtlMs),
  quietCheckMs: seconds(options?.quietCheckSec, DEFAULTS.quietCheckMs),
  staleMs: seconds(options?.staleSec, DEFAULTS.staleMs),
  notifyAfterMs: seconds(options?.notifyAfterSec, DEFAULTS.notifyAfterMs),
  statusLine: typeof options?.statusLine === 'boolean' ? options.statusLine : DEFAULTS.statusLine,
})

// Bump a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'bg-watch', key: 'jobs' } as const, [], { shape: 'jobs-3' })
const agents = atom({ plugin: 'bg-watch', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const tick = atom({ plugin: 'bg-watch', key: 'tick' } as const, 0)

const shortModel = (model: string) => model.replace(/^claude-/, '')

const isDone = (job: Job) => job.status !== 'running'

const mark = (status: string) =>
  status === 'running'
    ? '▶'
    : status === 'completed'
      ? '✓'
      : status === 'ended' || status === 'expired' || status === 'stopped'
        ? '■'
        : '✗'

const KIND_TAG: Record<JobKind, string> = { bash: '', monitor: '[mon] ', workflow: '[wf] ' }

const titleOf = (job: Job) => `${KIND_TAG[job.kind] ?? ''}${job.description || job.command}`

/** `failed (exit 1)`, `completed`, … */
const outcomeOf = (job: Job) =>
  job.exitCode !== undefined && job.exitCode !== 0 ? `${job.status} (exit ${job.exitCode})` : job.status

// Module memory, lost on reload (which only costs one early check or a
// later notice): settings, when each quiet job was last asked about, whether
// lsof could not run, and the folder task output files sit in.
let config: Config = DEFAULTS
const releaseCheckedAt = new Map<string, number>()
let lsofBroken = false
let tasksDir = ''

/** True when no process holds the file open: the command has exited. */
async function released($: EngineInterface, path: string) {
  if (lsofBroken) return false
  try {
    const { exitCode, stdout } = await $.process.run(['lsof', '-t', '--', path], {
      timeoutMs: 5000,
    })
    return exitCode !== 0 && stdout.trim() === ''
  } catch (error) {
    lsofBroken = true
    $.ui.log(`bg-watch: lsof unavailable (${String(error)}); jobs end only on their notification`)
    return false
  }
}

/**
 * Marks a job ended once; a notification's word replaces bg-watch's own guess
 * (`ended`, `expired`). Toasts, and sends an OS notification for a long job.
 */
async function endJob(
  $: EngineInterface,
  id: string,
  status: string,
  extra: { path?: string; exitCode?: number } = {},
) {
  const now = await $.clock.now()
  if (extra.path) tasksDir ||= tasksDirOf(extra.path)
  let ended: Job | undefined
  await update($, jobs, all =>
    all.map(job => {
      if (job.id !== id) return job
      if (job.status === 'running') {
        ended = { ...job, status, endedAt: now, path: job.path || extra.path || '', exitCode: extra.exitCode }
        return ended
      }
      const guessed = job.status === 'ended' || job.status === 'expired'
      return guessed && status !== job.status ? { ...job, status, exitCode: extra.exitCode } : job
    }),
  )
  releaseCheckedAt.delete(id)
  if (!ended) return
  const ran = now - ended.startedAt
  const text = `${mark(ended.status)} ${clip(titleOf(ended), 50)} ${outcomeOf(ended)} (${elapsed(ran)})`
  $.ui.toast(text)
  if (config.notifyAfterMs > 0 && ran >= config.notifyAfterMs) {
    await $.ui
      .notify(text, { title: 'bg-watch' })
      .catch(error => $.ui.log(`bg-watch: notification failed: ${String(error)}`))
  }
  await showStatus($)
}

/** Stops a job from the pane, as the model's TaskStop would. */
async function stopJob($: EngineInterface, id: string) {
  const ran = await $.tool.call({ tool: 'TaskStop', task_id: id })
  if (ran.deny !== undefined || ran.isError) {
    $.ui.toast(`bg-watch: could not stop ${id}: ${ran.deny ?? ran.text ?? 'error'}`)
    return
  }
  await endJob($, id, 'killed')
}

/** Reads what a running job's output file gained since the last poll. */
async function readGrowth($: EngineInterface, job: Job, size: number, now: number) {
  // A file that shrank was rewritten: start over.
  const restart = size < job.bytes
  const offset = restart ? 0 : Math.max(job.bytes, size - READ_MAX)
  const piece = readPiece(
    await $.fs.read(job.path, { offset, length: Math.min(size - offset, READ_MAX) }),
  )
  const base = restart ? { oks: 0, failures: 0, plan: undefined, progress: undefined, lastLine: '' } : job
  const oks = base.oks + piece.oks
  const tapFailures = base.failures + piece.failures
  const plan = piece.plan ?? base.plan
  const progress =
    plan !== undefined && oks + tapFailures > 0 ? `${oks + tapFailures}/${plan}` : (piece.progress ?? base.progress)
  return {
    oks,
    plan,
    progress,
    failures: piece.summaryFailures ?? tapFailures,
    lastLine: piece.lastLine || base.lastLine,
    bytes: size,
    updatedAt: now,
  } satisfies Partial<Job>
}

/** One poll: read new output, notice exits, drop rows past their time. */
async function poll($: EngineInterface) {
  const list = await read($, jobs)
  const now = await $.clock.now()
  const seen = new Map<string, Partial<Job>>()
  const gone: { id: string; status: string }[] = []

  for (const job of list) {
    if (job.status !== 'running') continue
    if (job.deadline !== undefined && now > job.deadline + DEADLINE_GRACE_MS) {
      gone.push({ id: job.id, status: 'expired' })
      continue
    }
    if (!job.path) continue
    let size: number
    try {
      size = (await $.fs.stat(job.path)).size
    } catch {
      if (job.kind === 'bash' && now - job.startedAt > MISSING_GRACE_MS && !(await $.fs.exists(job.path))) {
        gone.push({ id: job.id, status: 'ended' })
      }
      continue
    }
    if (size !== job.bytes) {
      try {
        seen.set(job.id, await readGrowth($, job, size, now))
      } catch (error) {
        $.ui.log(`bg-watch: reading ${job.path} failed: ${String(error)}`)
      }
      continue
    }
    // Quiet: no notification may ever come (a subagent's job, a missed
    // delivery), so ask whether the command still holds its output file.
    // Only a Bash job: a quiet Monitor is a Monitor waiting for its event.
    if (job.kind !== 'bash') continue
    if (now - job.updatedAt < config.quietCheckMs) continue
    if (now - (releaseCheckedAt.get(job.id) ?? 0) < RELEASE_CHECK_EVERY_MS) continue
    releaseCheckedAt.set(job.id, now)
    if (await released($, job.path)) gone.push({ id: job.id, status: 'ended' })
  }

  if (seen.size > 0) {
    await update($, jobs, all =>
      all.map(job => (seen.has(job.id) && job.status === 'running' ? { ...job, ...seen.get(job.id) } : job)),
    )
  }
  for (const { id, status } of gone) await endJob($, id, status)

  // Finished rows leave after a while instead of staying for good.
  const ttl = config.finishedTtlMs
  const current = await read($, jobs)
  if (current.some(job => isDone(job) && now - (job.endedAt ?? now) > ttl)) {
    await update($, jobs, all => all.filter(job => !isDone(job) || now - (job.endedAt ?? now) <= ttl))
  }
  const agentList = await read($, agents)
  if (agentList.some(row => row.id !== 'main' && now - row.lastAt > ttl)) {
    const roster = await $.agent.list().catch(() => [])
    const live = new Set(roster.filter(one => one.status === 'running').map(one => one.id))
    const stale = (row: AgentRow) => row.id !== 'main' && !live.has(row.id) && now - row.lastAt > ttl
    if (agentList.some(stale)) await update($, agents, all => all.filter(row => !stale(row)))
  }

  // Elapsed times move even when nothing was written: the pane alone reads
  // `tick`, so the transcript's rows are not redrawn for it.
  if (current.some(job => job.status === 'running')) await update($, tick, n => (n ?? 0) + 1)
  await showStatus($)
}

/** Records a background task a tool call started. */
async function addJob($: EngineInterface, job: Omit<Job, 'startedAt' | 'updatedAt' | 'status' | 'bytes' | 'failures' | 'oks' | 'lastLine'>) {
  const now = await $.clock.now()
  const full: Job = { ...job, startedAt: now, updatedAt: now, status: 'running', bytes: 0, failures: 0, oks: 0, lastLine: '' }
  if (full.path) tasksDir ||= tasksDirOf(full.path)
  await update($, jobs, all => [...all.filter(one => one.id !== full.id), full].slice(-KEEP_JOBS))
  await showStatus($)
}

/** The one-line reading of a job, as the pane and the transcript row draw it. */
const summaryOf = (job: Job, now: number) => {
  const end = job.endedAt ?? now
  const stale = job.status === 'running' && job.path !== '' && now - job.updatedAt > config.staleMs
  return [
    job.progress ? `${job.progress}` : '',
    job.failures > 0 ? `not ok ×${job.failures}` : '',
    isDone(job) ? outcomeOf(job) : '',
    elapsed(end - job.startedAt),
    stale ? `(quiet ${elapsed(now - job.updatedAt)})` : '',
  ]
    .filter(part => part !== '')
    .join('  ')
}

export const register: Register = (on, options) => {
  config = configOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bg-watch',
      description: 'Open the background jobs & subagents pane; "close" closes it, "clear" drops finished rows',
    })

    let busy = false
    $.clock.every(POLL_MS, async () => {
      if (busy) return // a slow lsof must not stack polls
      busy = true
      try {
        await poll($)
      } catch (error) {
        $.ui.log(`bg-watch: poll failed: ${String(error)}`)
      } finally {
        busy = false
      }
    })

    return next(e)
  })

  on('command.run', { command: 'bg-watch' }, async ($, e) => {
    if (/\bclear\b/.test(e.args)) {
      await update($, jobs, all => all.filter(job => job.status === 'running'))
      await update($, agents, all => all.filter(row => row.id === 'main'))
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

  // A background Bash call, the main agent's or a subagent's.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const result = ran.result as BashBackground | undefined
    if (!result?.backgroundTaskId) return ran
    const path = outputPathOf(ran.text, result.stdout) || result.backgroundOutputPath || ''
    if (!path) $.ui.log(`bg-watch: no output file found for background task ${result.backgroundTaskId}`)
    await addJob($, {
      id: result.backgroundTaskId,
      kind: 'bash',
      toolUseId: e.tool_use_id,
      command: clip(e.command.replace(/\s+/g, ' ').trim(), 120),
      description: clip(e.description ?? '', 80),
      path,
    })
    return ran
  }).catch(($, e, next) => next(e))

  // A Monitor: ends on its notification, a TaskStop, or past its deadline.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    if (e.tool !== 'Monitor') return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !ran.result?.taskId) return ran
    const { taskId, timeoutMs, persistent } = ran.result
    const now = await $.clock.now()
    const guess = tasksDir ? `${tasksDir}/${taskId}.output` : ''
    const path = guess && (await $.fs.exists(guess).catch(() => false)) ? guess : ''
    await addJob($, {
      id: taskId,
      kind: 'monitor',
      toolUseId: e.tool_use_id,
      command: clip((e.command ?? '').replace(/\s+/g, ' ').trim(), 120),
      description: clip(e.description ?? '', 80),
      path,
      deadline: persistent || !timeoutMs ? undefined : now + timeoutMs,
    })
    return ran
  }).catch(($, e, next) => next(e))

  // A Workflow run in the background: ends on its notification.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (e.tool !== 'Workflow') return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !ran.result?.taskId) return ran
    const name = ran.result.workflowName ?? 'workflow'
    await addJob($, {
      id: ran.result.taskId,
      kind: 'workflow',
      toolUseId: e.tool_use_id,
      command: clip(name, 120),
      description: clip(name, 80),
      path: '',
    })
    return ran
  }).catch(($, e, next) => next(e))

  // A job the model stopped: its notification may never come.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    if (e.tool !== 'TaskStop') return next(e)
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id && ran.deny === undefined && !ran.isError) await endJob($, id, 'killed')
    return ran
  }).catch(($, e, next) => next(e))

  // The end of a background task arrives as a task notification: as a turn
  // of its own, or delivered into a running one.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const note = notificationOf(e.text)
      if (note) await endJob($, note.id, note.status, note)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A subagent's own task notifications reach its loop here, not prompt.submit.
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const note = notificationOf(e.text)
      if (note) await endJob($, note.id, note.status, note)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every model request, main's or a subagent's: what was actually sent.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? 'main'
    const effort = e.effort === undefined ? '-' : String(e.effort)
    void $.clock
      .now()
      .then(now =>
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
      .catch(error => $.ui.log(`bg-watch: recording a step failed: ${String(error)}`))
    return yield* next(e)
  })

  // The job's reading under the tool call that started it, in the transcript.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, tool_use_id } = e.props
    if (tool !== 'Bash' && tool !== 'Monitor' && tool !== 'Workflow') return next(e)
    const job = (await read($, jobs)).find(one => one.toolUseId === tool_use_id)
    if (!job) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const row = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        <Text dimColor>
          {'  ⎿ '}
          {mark(job.status)} {summaryOf(job, now)}
          {job.status === 'running' && job.lastLine !== '' ? `  ${clip(job.lastLine, 80)}` : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [jobList, agentList, roster, now] = await Promise.all([
      read($, jobs),
      read($, agents),
      $.agent.list().catch(() => []),
      $.clock.now(),
      read($, tick),
    ])
    const info = new Map(roster.map(one => [one.id, one]))
    const subagents = agentList.filter(row => row.id !== 'main')
    const main = agentList.find(row => row.id === 'main')
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 8)
    // Running jobs first, then the newest finished ones.
    const ordered = [...jobList.filter(job => !isDone(job)), ...jobList.filter(isDone).reverse()]
    const jobRows = ordered.slice(0, Math.ceil(room / 3))
    const agentRows = subagents.slice(-Math.max(2, room - jobRows.length * 2))

    return (
      <Box flexDirection="column">
        <Text bold>Background jobs</Text>
        {jobRows.length === 0 && <Text dimColor>  none</Text>}
        {jobRows.map(job => {
          const color =
            job.status === 'completed' ? 'green' : job.status === 'running' || mark(job.status) === '■' ? undefined : 'red'
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={color} dimColor={mark(job.status) === '■'}>
                  {mark(job.status)} {clip(titleOf(job), 48)}  {summaryOf(job, now)}
                  {job.status === 'running' && !job.path && job.kind === 'bash' ? '  (no output file)' : ''}
                </Text>
                {job.status === 'running' && (
                  <Button key={`stop-${job.id}`} label="stop" dimColor onPress={() => stopJob($, job.id)} />
                )}
              </Box>
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
        {agentRows.length === 0 && <Text dimColor>  none</Text>}
        {agentRows.map(row => {
          const one = info.get(row.id)
          const status = one?.status ?? '?'
          const out = (one?.usage ?? []).reduce((n, u) => n + u.output_tokens, 0)
          const cost = one?.cost?.usd
          return (
            <Text dimColor={status !== 'running'}>
              {status === 'running' ? '▶' : '·'} {clip(one?.type ?? row.id, 22).padEnd(22)}{' '}
              {clip(one?.description ?? '', 28).padEnd(28)} {shortModel(row.model)}@{row.effort}
              {`  ${row.steps} steps  ${elapsed(row.lastAt - row.firstAt)}`}
              {out > 0 ? `  ${tokens(out)} out` : ''}
              {cost !== undefined ? `  $${cost.toFixed(2)}` : ''}
            </Text>
          )
        })}
      </Box>
    )
  })
}

/** One status-line entry for running jobs, cleared when none run. */
async function showStatus($: EngineInterface) {
  if (!config.statusLine) {
    $.ui.status(undefined)
    return
  }
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
    `▶ ${clip(titleOf(first), 30)}${first.progress ? ` ${first.progress}` : ''} · ${elapsed(now - first.startedAt)}${more}`,
  )
}
