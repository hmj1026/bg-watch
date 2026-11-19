/** Pure text parsing for bg-watch: no `$`, so tests call it directly. */

/** East Asian wide and fullwidth characters, and emoji: two cells in a terminal. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u

const cellOf = (ch: string) => (WIDE.test(ch) ? 2 : 1)

/** How many terminal cells the text takes. */
export const cells = (text: string) => {
  let n = 0
  for (const ch of text) n += cellOf(ch)
  return n
}

/** Text without ANSI escapes and control characters, which take no cells or move the cursor. */
export const plain = (text: string) =>
  text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '').replace(/[\u0000-\u001f\u007f]/g, '')

/** Text cut to `max` cells, ending in `…` when cut. */
export const clip = (text: string, max: number) => {
  if (cells(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    if (used + cellOf(ch) > max - 1) break
    out += ch
    used += cellOf(ch)
  }
  return `${out}…`
}

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** `12345` → `12.3k`. */
export const tokens = (n: number) =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`

/**
 * The output file of a background Bash call. The record's `stdout` is empty
 * and `backgroundOutputPath` is set only for a remote machine, so the path is
 * read off the text the model gets: "Output is being written to: <path>."
 */
export const outputPathOf = (...texts: (string | undefined)[]) => {
  for (const text of texts) {
    const found = text && /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(text)?.[1]
    if (found) return found
  }
  return ''
}

/** The folder a task's output file sits in (`…/tasks`), or `''`. */
export const tasksDirOf = (path: string) => /^(.*\/tasks)\/[^/]+\.output$/.exec(path)?.[1] ?? ''

export type Notification = {
  id: string
  status: string
  path?: string
  exitCode?: number
}

/** `<task-id>`, `<status>`, `<output-file>` and the exit code of a task notification. */
export const notificationOf = (text: string): Notification | undefined => {
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim()
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim()
  if (!id || !status) return undefined
  const path = /<output-file>([^<]+)<\/output-file>/.exec(text)?.[1]?.trim()
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? ''
  const code = /exit code (\d+)\)?\s*$/.exec(summary.trim())?.[1]
  return { id, status, path, exitCode: code === undefined ? undefined : Number(code) }
}

/** What one piece of output adds to a job's reading. */
export type Reading = {
  /** TAP `ok` lines in the piece. */
  oks: number
  /** TAP `not ok` lines in the piece. */
  failures: number
  /** A TAP plan `1..N` in the piece. */
  plan?: number
  /** A progress figure the piece states itself (a test runner's summary, a percent, `N/M`). */
  progress?: string
  /** Failures a runner's own summary states; it replaces the counted ones. */
  summaryFailures?: number
  lastLine: string
}

const lastMatch = (text: string, re: RegExp) => {
  let found: RegExpExecArray | undefined
  for (const m of text.matchAll(re)) found = m
  return found
}

/**
 * A progress figure, the most specific form first:
 * jest (`Tests: 2 failed, 8 passed, 10 total`), vitest (`Tests  2 failed | 8 passed (10)`),
 * pytest (`[ 45%]`), a percent at a line's end, then `N/M` standing alone
 * (not a date, a path or a fraction inside a word).
 */
export const progressOf = (tail: string): { progress?: string; failures?: number } => {
  const jest = lastMatch(tail, /^\s*Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(?:(\d+) passed, )?(\d+) total/gm)
  if (jest) {
    const failed = Number(jest[1] ?? 0)
    const passed = Number(jest[2] ?? 0)
    return { progress: `${failed + passed}/${jest[3]}`, failures: failed }
  }
  const vitest = lastMatch(tail, /^\s*Tests\s+(?:(\d+) failed \| )?(?:(\d+) passed)?[^(\n]*\((\d+)\)/gm)
  if (vitest) {
    const failed = Number(vitest[1] ?? 0)
    const passed = Number(vitest[2] ?? 0)
    return { progress: `${failed + passed}/${vitest[3]}`, failures: failed }
  }
  const pytest = lastMatch(tail, /\[\s*(\d{1,3})%\]\s*$/gm)
  if (pytest) return { progress: `${pytest[1]}%` }
  const percent = lastMatch(tail, /(?<![\w.])(\d{1,3}(?:\.\d+)?)%\s*$/gm)
  if (percent && Number(percent[1]) <= 100) return { progress: `${percent[1]}%` }
  const ratio = lastMatch(tail, /(?<![\w/.-])(\d+)\s*\/\s*(\d+)(?![\w/.-])/g)
  if (ratio && Number(ratio[2]) > 0 && Number(ratio[1]) <= Number(ratio[2])) {
    return { progress: `${ratio[1]}/${ratio[2]}` }
  }
  return {}
}

/** Reads one piece of output: TAP counts over all of it, the rest off its tail. */
export const readPiece = (text: string): Reading => {
  const tail = text.slice(-64 * 1024)
  const lines = tail.split('\n').map(line => line.trimEnd())
  const lastLine = [...lines].reverse().find(line => line.trim() !== '') ?? ''
  const plan = lastMatch(text, /^\s*1\.\.(\d+)\s*$/gm)?.[1]
  const found = progressOf(tail)
  return {
    oks: (text.match(/^\s*ok\b/gm) ?? []).length,
    failures: (text.match(/^\s*not ok\b/gm) ?? []).length,
    plan: plan === undefined ? undefined : Number(plan),
    progress: found.progress,
    summaryFailures: found.failures,
    lastLine: clip(plain(lastLine).trim(), 160),
  }
}
