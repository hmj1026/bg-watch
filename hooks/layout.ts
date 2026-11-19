/**
 * Pure layout for bg-watch's band and pane: no `$`, so tests call it directly.
 * Every row is laid out to a width in cells and never wraps.
 */
import type { AgentRow, Job, Tally } from '../types'
import { cells, clip, elapsed } from './parse'

/** A theme key per state, so the surface's own palette draws it. */
export type Tone = 'running' | 'ok' | 'bad' | 'stopped' | 'unknown'

export const TONE_COLOR: Record<Tone, string | undefined> = {
  running: 'suggestion',
  ok: 'success',
  bad: 'error',
  stopped: 'inactive',
  unknown: 'warning',
}

/** Running or not yet known: still in the live list. */
export const isLive = (job: Job) => job.status === 'running' || job.status === 'unknown'
export const isDone = (job: Job) => !isLive(job)

const STOPPED = new Set(['killed', 'stopped', 'ended', 'expired'])

export const toneOf = (status: string): Tone =>
  status === 'running'
    ? 'running'
    : status === 'completed'
      ? 'ok'
      : status === 'unknown'
        ? 'unknown'
        : STOPPED.has(status)
          ? 'stopped'
          : 'bad'

export const TONE_GLYPH: Record<Tone, string> = { running: '▶', ok: '✓', bad: '✗', stopped: '■', unknown: '?' }

export const mark = (status: string) => TONE_GLYPH[toneOf(status)]

/** Text cut to `width` cells with `…`; empty at zero. */
export const fit = (text: string, width: number) => (width <= 0 ? '' : clip(text, width))

/** Text cut and padded to exactly `width` cells. */
export const pad = (text: string, width: number) => {
  const cut = fit(text, width)
  return cut + ' '.repeat(Math.max(0, width - cells(cut)))
}

/** An agent roster status that is over: anything else (running, waiting, idle) is still alive. */
export const isFinishedAgentStatus = (status: string | undefined) =>
  status === undefined || status === 'completed' || status === 'failed' || status === 'killed'

export const shortModel = (model: string) => model.replace(/^claude-/, '')

export const shortEffort = (effort: string) => (effort === 'medium' ? 'med' : effort)

/** A poll loop's shell (`until grep … x.output; do sleep 5; done`) read as what it waits for. */
export const stripPoll = (command: string) => {
  const loop = /^(?:until|while)\s+(.+?);\s*do\b/.exec(command)
  if (!loop) return command
  const file = /([\w.-]+)\.output\b/.exec(loop[1]!)
  return file ? `wait for ${file[1]}` : `wait: ${loop[1]}`
}

const KIND_TAG: Record<string, string> = { bash: '', monitor: 'mon ', workflow: 'wf ' }

/** The job's name: its description, or its command without a poll loop's shell. */
export const nameOf = (job: Job) => `${KIND_TAG[job.kind] ?? ''}${job.description || stripPoll(job.command)}`

/** The figures right of a job's name, most important last (the elapsed time). */
export const jobFigures = (job: Job, now: number, staleMs: number) => {
  const end = job.endedAt ?? now
  const quietFor = now - job.updatedAt
  const hasOutput = job.bytes > 0
  return [
    job.progress ?? '',
    job.failures > 0 ? `×${job.failures}` : '',
    job.status === 'failed' && job.exitCode !== undefined ? `exit ${job.exitCode}` : '',
    toneOf(job.status) === 'stopped' ? job.status : '',
    job.status === 'unknown' ? 'no output file' : '',
    job.status === 'running' && !hasOutput ? 'no output yet' : '',
    job.status === 'running' && hasOutput && quietFor > staleMs ? `quiet ${elapsed(quietFor)}` : '',
    elapsed(end - job.startedAt),
  ].filter(part => part !== '')
}

/**
 * One row: `▸ ✗ name……  figures`. The name takes what the figures leave; when
 * that drops under 8 cells the leading figures go first, the elapsed time last.
 */
export const rowText = (arrow: string, glyph: string, name: string, figures: string[], width: number) => {
  const head = `${arrow} ${glyph} `
  let kept = figures
  const rightOf = (parts: string[]) => parts.join('  ')
  while (kept.length > 1 && width - cells(head) - cells(rightOf(kept)) - 2 < 8) kept = kept.slice(1)
  const right = rightOf(kept)
  const nameWidth = Math.max(1, width - cells(head) - cells(right) - 2)
  return fit(`${head}${pad(name, nameWidth)}  ${right}`, width)
}

/**
 * The job the band names: only a running one, never a finished one, so the band
 * does not keep showing the last job after all are done. One with progress
 * first, then the longest running.
 */
export const focusJob = (jobs: readonly Job[]) => {
  const running = jobs.filter(job => job.status === 'running')
  return running.find(job => job.progress) ?? [...running].sort((a, b) => a.startedAt - b.startedAt)[0]
}

/** What `[clear]` and expiry dropped, so the session's totals outlive the rows. */
export type { Tally }

export const EMPTY_TALLY: Tally = { completed: 0, failed: 0, stopped: 0, agents: 0 }

export type Totals = Tally & { lastAt?: number }

/** Adds finished rows to a tally: what leaves the lists still counts. */
export const tallyOf = (base: Tally, jobs: readonly Job[], agentsDone: number): Tally => {
  const done = jobs.filter(isDone)
  const count = (tone: Tone) => done.filter(job => toneOf(job.status) === tone).length
  return {
    completed: base.completed + count('ok'),
    failed: base.failed + count('bad'),
    stopped: base.stopped + count('stopped'),
    agents: base.agents + agentsDone,
  }
}

/** The session's totals: the rows still listed plus what left them. */
export const totalsOf = (
  base: Tally,
  jobs: readonly Job[],
  doneAgents: readonly AgentRow[],
): Totals => {
  const ends = [...jobs.filter(isDone).map(job => job.endedAt ?? 0), ...doneAgents.map(row => row.lastAt)]
  return { ...tallyOf(base, jobs, doneAgents.length), lastAt: ends.length > 0 ? Math.max(...ends) : undefined }
}

export const hasHistory = (totals: Totals) =>
  totals.completed + totals.failed + totals.stopped + totals.agents > 0

/** `✓5 ✗1 ■1` as tone-colored parts; a zero is left out. */
export const totalsParts = (totals: Tally): { tone: Tone; text: string }[] =>
  [
    { tone: 'ok' as const, n: totals.completed, glyph: '✓' },
    { tone: 'bad' as const, n: totals.failed, glyph: '✗' },
    { tone: 'stopped' as const, n: totals.stopped, glyph: '■' },
  ]
    .filter(part => part.n > 0)
    .map(part => ({ tone: part.tone, text: `${part.glyph}${part.n}` }))
