import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, PluginOptions, Register } from 'claude-code'

import type { AgentRow, Job, Tally } from '../types'
import { EMPTY_TALLY, focusJob, isDone, isFinishedAgentStatus, isLive, jobFigures, mark, nameOf, tallyOf, totalsOf } from './layout'
import { clip, elapsed, notificationOf, outputPathOf, readPiece, tasksDirOf } from './parse'
import { DEFAULT_VIEW, bandRow, paneBody } from './view'
import type { Actions, Snapshot } from './view'

type BashBackground = {
  stdout?: string
  backgroundTaskId?: string
  backgroundOutputPath?: string
}

const PANE = 'bg-watch'
/** The dock width asked for on open; a width the person dragged wins. */
const PANE_COLUMNS = 60
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
/** A failure this recent still counts on the band while others run. */
const RECENT_FAIL_MS = 300_000

/** The `userConfig` fields, as numbers in milliseconds where they are times. */
type Config = {
  finishedTtlMs: number
  quietCheckMs: number
  staleMs: number
  notifyAfterMs: number
  statusLine: boolean
  band: boolean
}

const DEFAULTS: Config = {
  finishedTtlMs: 1_800_000,
  quietCheckMs: 10_000,
  staleMs: 60_000,
  notifyAfterMs: 120_000,
  statusLine: false,
  band: true,
}

const seconds = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1000 : fallback

const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

const configOf = (options: PluginOptions | undefined): Config => ({
  finishedTtlMs: seconds(options?.finishedTtlSec, DEFAULTS.finishedTtlMs),
  quietCheckMs: seconds(options?.quietCheckSec, DEFAULTS.quietCheckMs),
  staleMs: seconds(options?.staleSec, DEFAULTS.staleMs),
  notifyAfterMs: seconds(options?.notifyAfterSec, DEFAULTS.notifyAfterMs),
  statusLine: flag(options?.statusLine, DEFAULTS.statusLine),
  band: flag(options?.band, DEFAULTS.band),
})

// Bump a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'bg-watch', key: 'jobs' } as const, [], { shape: 'jobs-3' })
const agents = atom({ plugin: 'bg-watch', key: 'agents' } as const, [], { shape: 'agents-2' })
const tally = atom({ plugin: 'bg-watch', key: 'tally' } as const, EMPTY_TALLY, { shape: 'tally-1' })
const view = atom({ plugin: 'bg-watch', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-1' })
const paneOpen = atom({ plugin: 'bg-watch', key: 'paneOpen' } as const, false)
const tick = atom({ plugin: 'bg-watch', key: 'tick' } as const, 0)

/** `failed (exit 1)`, `completed`, … */
const outcomeOf = (job: Job) =>
  job.exitCode !== undefined && job.exitCode !== 0 ? `${job.status} (exit ${job.exitCode})` : job.status

const addTally = (base: Tally, more: Tally): Tally => ({
  completed: base.completed + more.completed,
  failed: base.failed + more.failed,
  stopped: base.stopped + more.stopped,
  agents: base.agents + more.agents,
})

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
      if (!isDone(job)) {
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
  const text = `${mark(ended.status)} ${clip(nameOf(ended), 50)} ${outcomeOf(ended)} (${elapsed(ran)})`
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

/** Agent ids the roster still holds alive (running, waiting, idle). */
async function liveAgentIds($: EngineInterface) {
  const roster = await $.agent.list().catch(() => [] as AgentInfo[])
  return new Set(roster.filter(one => !isFinishedAgentStatus(one.status)).map(one => one.id))
}

/** Drops finished jobs and agent rows, keeping their count in the tally. */
async function clearFinished($: EngineInterface) {
  const live = await liveAgentIds($)
  let droppedJobs: Job[] = []
  await update($, jobs, all => {
    droppedJobs = all.filter(isDone)
    return all.filter(isLive)
  })
  let droppedAgents = 0
  await update($, agents, all => {
    droppedAgents = all.filter(row => row.id !== 'main' && !live.has(row.id)).length
    return all.filter(row => row.id === 'main' || live.has(row.id))
  })
  await update($, tally, base => tallyOf(base, droppedJobs, droppedAgents))
  await showStatus($)
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

/** Reads running jobs' output and returns those that ended without a notification. */
async function scanJobs($: EngineInterface, list: readonly Job[], now: number) {
  const seen = new Map<string, Partial<Job>>()
  const gone: { id: string; status: string }[] = []

  for (const job of list) {
    // A job never seen to start writing ends after the finished-row time.
    if (job.status === 'unknown' && now - job.startedAt > config.finishedTtlMs) gone.push({ id: job.id, status: 'ended' })
    if (job.status !== 'running') continue
    if (job.deadline !== undefined && now > job.deadline + DEADLINE_GRACE_MS) {
      gone.push({ id: job.id, status: 'expired' })
      continue
    }
    if (!job.path) {
      // A Bash job whose output file never turned up: not counted as running.
      if (job.kind === 'bash' && now - job.startedAt > config.staleMs) seen.set(job.id, { status: 'unknown' })
      continue
    }
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
  return { seen, gone }
}

/** Keeps each subagent's name, task, tokens and cost from the roster, so they outlive it. */
const enrich = (row: AgentRow, one: AgentInfo | undefined): AgentRow => {
  if (!one) return row
  const out = (one.usage ?? []).reduce((n, u) => n + u.output_tokens, 0)
  const next = {
    ...row,
    type: one.type ?? row.type,
    description: one.description ?? row.description,
    outTokens: out > 0 ? out : row.outTokens,
    costUsd: one.cost?.usd ?? row.costUsd,
  }
  const same =
    next.type === row.type &&
    next.description === row.description &&
    next.outTokens === row.outTokens &&
    next.costUsd === row.costUsd
  return same ? row : next
}

/** Agent rows: kept up to date from the roster; finished ones past their time leave. */
async function sweepAgents($: EngineInterface, now: number) {
  const agentList = await read($, agents)
  if (!agentList.some(row => row.id !== 'main')) return
  const roster = await $.agent.list().catch(() => [] as AgentInfo[])
  const info = new Map(roster.map(one => [one.id, one]))
  const live = new Set(roster.filter(one => !isFinishedAgentStatus(one.status)).map(one => one.id))
  const stale = (row: AgentRow) => row.id !== 'main' && !live.has(row.id) && now - row.lastAt > config.finishedTtlMs
  const dropped = agentList.filter(stale).length
  const changed = dropped > 0 || agentList.some(row => enrich(row, info.get(row.id)) !== row)
  if (!changed) return
  let gone = 0
  await update($, agents, all => {
    gone = all.filter(stale).length
    return all.filter(row => !stale(row)).map(row => enrich(row, info.get(row.id)))
  })
  if (gone > 0) await update($, tally, base => addTally(base, { ...EMPTY_TALLY, agents: gone }))
}

/** One poll: read new output, notice exits, drop rows past their time. */
async function poll($: EngineInterface) {
  const now = await $.clock.now()
  const { seen, gone } = await scanJobs($, await read($, jobs), now)

  if (seen.size > 0) {
    await update($, jobs, all =>
      all.map(job => (seen.has(job.id) && job.status === 'running' ? { ...job, ...seen.get(job.id) } : job)),
    )
  }
  for (const { id, status } of gone) await endJob($, id, status)

  // Finished rows leave after a while; the tally keeps their count.
  const ttl = config.finishedTtlMs
  const current = await read($, jobs)
  const expired = (job: Job) => isDone(job) && now - (job.endedAt ?? now) > ttl
  if (current.some(expired)) {
    let left: Job[] = []
    await update($, jobs, all => {
      left = all.filter(expired)
      return all.filter(job => !expired(job))
    })
    await update($, tally, base => tallyOf(base, left, 0))
  }
  await sweepAgents($, now)

  // Elapsed times move even when nothing was written: the pane and band read
  // `tick`, so the transcript's rows are not redrawn for it.
  const busy = current.some(job => job.status === 'running')
  if (busy || (await read($, agents)).some(row => row.id !== 'main')) await update($, tick, n => (n ?? 0) + 1)
  await showStatus($)
}

/** Records a background task a tool call started. */
async function addJob($: EngineInterface, job: Omit<Job, 'startedAt' | 'updatedAt' | 'status' | 'bytes' | 'failures' | 'oks' | 'lastLine'>) {
  const now = await $.clock.now()
  const full: Job = { ...job, startedAt: now, updatedAt: now, status: 'running', bytes: 0, failures: 0, oks: 0, lastLine: '' }
  if (full.path) tasksDir ||= tasksDirOf(full.path)
  // Over the cap the oldest finished rows leave first, counted in the tally.
  let evicted: Job[] = []
  await update($, jobs, all => {
    const list = [...all.filter(one => one.id !== full.id), full]
    const over = list.length - KEEP_JOBS
    if (over <= 0) return list
    const done = list.filter(isDone).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    evicted = done.slice(0, over)
    const out = new Set(evicted.map(job => job.id))
    return list.filter(job => !out.has(job.id)).slice(-KEEP_JOBS)
  })
  if (evicted.length > 0) await update($, tally, base => tallyOf(base, evicted, 0))
  await showStatus($)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Background & agents', columns: PANE_COLUMNS })
  await update($, paneOpen, () => true)
}

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await update($, paneOpen, () => false)
}

/** What the band and the pane draw from, read in one go. */
async function snapshot($: EngineInterface, viewingAgent?: string): Promise<Snapshot> {
  const [jobList, agentList, roster, now, base, viewState, open] = await Promise.all([
    read($, jobs),
    read($, agents),
    $.agent.list().catch(() => [] as AgentInfo[]),
    $.clock.now(),
    read($, tally),
    read($, view),
    read($, paneOpen),
    read($, tick),
  ])
  const info = new Map(roster.map(one => [one.id, one]))
  const doneAgents = agentList.filter(row => row.id !== 'main' && isFinishedAgentStatus(info.get(row.id)?.status))
  return {
    jobs: jobList,
    agents: agentList,
    roster: info,
    totals: totalsOf(base, jobList, doneAgents),
    view: viewState,
    viewingAgent,
    paneOpen: open,
    now,
    staleMs: config.staleMs,
    recentFailMs: RECENT_FAIL_MS,
  }
}

const toggleIn = (list: readonly string[], id: string) =>
  list.includes(id) ? list.filter(one => one !== id) : [...list, id]

function actionsOf($: EngineInterface): Actions {
  const report = (what: string) => (error: unknown) => $.ui.log(`bg-watch: ${what} failed: ${String(error)}`)
  const viewOf = async (target: { agentId?: string }) => {
    const ran = await $.ui.view(target)
    if ('deny' in ran && ran.deny !== undefined) $.ui.toast(`bg-watch: ${ran.deny}`)
  }
  return {
    togglePane: () => void read($, paneOpen).then(open => (open ? closePane($) : openPane($))).catch(report('toggling the pane')),
    toggle: id => {
      const isSection = id === 'jobs' || id === 'jobs-done' || id === 'agents' || id === 'agents-done'
      void update($, view, v =>
        isSection ? { ...v, collapsed: toggleIn(v.collapsed, id) } : { ...v, expanded: toggleIn(v.expanded, id) },
      ).catch(report('toggling a row'))
    },
    stop: id => void stopJob($, id).catch(report('stopping a job')),
    copy: (text, press) =>
      void $.ui
        .copy({ text, surface: press.surface })
        .then(() => $.ui.toast('bg-watch: copied the output path'))
        .catch(report('copying')),
    viewAgent: id => void viewOf({ agentId: id }).catch(report('opening the transcript')),
    back: () => void viewOf({}).catch(report('going back')),
    clear: () => void clearFinished($).catch(report('clearing')),
    close: () => void closePane($).catch(report('closing the pane')),
  }
}

export const register: Register = (on, options) => {
  config = configOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bg-watch',
      description: 'Open the background jobs & subagents pane; "close" closes it, "clear" drops finished rows',
    })
    // A reload keeps the pane up: learn whether it is.
    const panes = await $.ui.panes().catch(() => [])
    await update($, paneOpen, () => panes.some(pane => pane.id === PANE))

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
      await clearFinished($)
      return { text: 'bg-watch: finished jobs and agent rows cleared.' }
    }
    if (/\bclose\b/.test(e.args)) {
      await closePane($)
      return { text: 'bg-watch pane closed.' }
    }
    await openPane($)
    return { text: 'bg-watch pane opened.' }
  })

  // The person's close mark, or an unload: the band's [open] follows.
  on('ui.close', async ($, e, next) => {
    const done = await next(e)
    if (e.id === PANE) await update($, paneOpen, () => false)
    return done
  }).catch(($, e, next) => next(e))

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
      .then(async now => {
        let evicted = 0
        await update($, agents, all => {
          const old = all.find(row => row.id === id)
          const row: AgentRow = {
            ...old,
            id,
            model: e.model,
            effort,
            steps: (old?.steps ?? 0) + 1,
            firstAt: old?.firstAt ?? now,
            lastAt: now,
          }
          const list = [...all.filter(one => one.id !== id), row]
          evicted = list.slice(0, Math.max(0, list.length - KEEP_AGENTS)).filter(one => one.id !== 'main').length
          return list.slice(-KEEP_AGENTS)
        })
        if (evicted > 0) await update($, tally, base => addTally(base, { ...EMPTY_TALLY, agents: evicted }))
      })
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
          {mark(job.status)} {jobFigures(job, now, config.staleMs).join('  ')}
          {job.status === 'running' && job.lastLine !== '' ? `  ${clip(job.lastLine, 80)}` : ''}
        </Text>
      </Box>
    )
  })

  // The band above the prompt: a one-line summary; a press opens or closes the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.band || e.props.hasSurvey) return next(e)
    const row = bandRow($.ui.resolve(e), await snapshot($), e.props.bodyColumns, actionsOf($))
    return row ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await snapshot($, e.props.view.agentId)
    return paneBody($.ui.resolve(e), s, e.props.bodyColumns, actionsOf($))
  })
}

/** One status-line entry for running jobs, cleared when none run; off unless asked for. */
async function showStatus($: EngineInterface) {
  if (!config.statusLine) {
    $.ui.status(undefined)
    return
  }
  const list = await read($, jobs)
  const now = await $.clock.now()
  const running = list.filter(job => job.status === 'running')
  const first = focusJob(list)
  if (!first) {
    $.ui.status(undefined)
    return
  }
  const more = running.length > 1 ? ` +${running.length - 1}` : ''
  $.ui.status(
    `▶ ${clip(nameOf(first), 30)}${first.progress ? ` ${first.progress}` : ''} · ${elapsed(now - first.startedAt)}${more}`,
  )
}
