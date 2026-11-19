/**
 * bg-watch's drawings: the band above the prompt and the pane. Each takes the
 * state already read and the actions to run on a press, so it draws and
 * nothing else.
 */
import type { AgentInfo, EngineInterface, UiPressArgument } from 'claude-code'

import type { AgentRow, Job, ViewState } from '../types'
import {
  EMPTY_TALLY,
  TONE_COLOR,
  TONE_GLYPH,
  focusJob,
  fit,
  hasHistory,
  isDone,
  isFinishedAgentStatus,
  isLive,
  jobFigures,
  mark,
  nameOf,
  pad,
  rowText,
  shortEffort,
  shortModel,
  tallyOf,
  toneOf,
  totalsParts,
} from './layout'
import type { Totals, Tone } from './layout'
import { elapsed, tokens } from './parse'

type Kit = ReturnType<EngineInterface['ui']['resolve']>

export type Actions = {
  togglePane: () => void
  toggle: (id: string) => void
  stop: (id: string) => void
  copy: (text: string, press: UiPressArgument) => void
  viewAgent: (id: string) => void
  back: () => void
  clear: () => void
  close: () => void
}

export type Snapshot = {
  jobs: readonly Job[]
  agents: readonly AgentRow[]
  roster: ReadonlyMap<string, AgentInfo>
  totals: Totals
  view: ViewState
  viewingAgent?: string
  paneOpen: boolean
  now: number
  staleMs: number
  recentFailMs: number
}

/** A section a person can fold: its id in `ViewState.collapsed`. */
export const SECTION = { jobs: 'jobs', jobsDone: 'jobs-done', agents: 'agents', agentsDone: 'agents-done' } as const

/** Folded until opened: the finished groups. */
export const DEFAULT_VIEW: ViewState = { expanded: [], collapsed: [SECTION.jobsDone, SECTION.agentsDone] }

const color = (tone: Tone) => TONE_COLOR[tone]

const isRunningAgent = (row: AgentRow, roster: ReadonlyMap<string, AgentInfo>) =>
  !isFinishedAgentStatus(roster.get(row.id)?.status)

const agentName = (row: AgentRow, roster: ReadonlyMap<string, AgentInfo>) => {
  const one = roster.get(row.id)
  return [one?.type ?? row.type ?? row.id, one?.description ?? row.description ?? ''].filter(Boolean).join('  ')
}

const outOf = (row: AgentRow, roster: ReadonlyMap<string, AgentInfo>) => {
  const usage = roster.get(row.id)?.usage
  return usage ? usage.reduce((n, u) => n + u.output_tokens, 0) : (row.outTokens ?? 0)
}

const subagents = (s: Snapshot) => s.agents.filter(row => row.id !== 'main')

// ---------------------------------------------------------------- band

/**
 * One line: `bg ▶3 jobs ✗1 failed ▶2 agents │ ▶ e2e 41/262 · 9m [open]`, or,
 * with nothing running, a dim summary of the session; `undefined` (no row)
 * before anything ran.
 */
export function bandRow(kit: Kit, s: Snapshot, width: number, act: Actions) {
  const { Button, Text } = kit
  const running = s.jobs.filter(job => job.status === 'running').length
  const unknown = s.jobs.filter(job => job.status === 'unknown').length
  const failed = s.jobs.filter(job => job.status === 'failed' && s.now - (job.endedAt ?? 0) <= s.recentFailMs).length
  const agentsRunning = subagents(s).filter(row => isRunningAgent(row, s.roster)).length
  const tail = s.paneOpen ? '  [close]' : '  [open]'

  if (running + agentsRunning === 0) {
    if (!hasHistory(s.totals) && unknown === 0) return undefined
    const parts = [...totalsParts(s.totals), ...(unknown > 0 ? [{ tone: 'unknown' as const, text: `?${unknown}` }] : [])]
    const used = 'bg idle · jobs '.length + parts.reduce((n, p) => n + p.text.length + 1, 0) + tail.length
    const last = s.totals.lastAt === undefined ? '' : ` · last activity ${elapsed(s.now - s.totals.lastAt)} ago`
    return (
      <Button key="band" onPress={act.togglePane}>
        <Text dimColor>bg idle · jobs </Text>
        {parts.map(p => (
          <Text color={color(p.tone)}>{p.text} </Text>
        ))}
        <Text dimColor>{fit(`· ${s.totals.agents} agents done${last}`, width - used)}</Text>
        <Text dimColor>{tail}</Text>
      </Button>
    )
  }

  const chips: { tone?: Tone; dim?: boolean; text: string }[] = [
    { tone: running > 0 ? 'running' : undefined, dim: running === 0, text: `▶${running} jobs  ` },
    ...(failed > 0 ? [{ tone: 'bad' as const, text: `✗${failed} failed  ` }] : []),
    ...(unknown > 0 ? [{ tone: 'unknown' as const, text: `?${unknown}  ` }] : []),
    { tone: agentsRunning > 0 ? 'running' : undefined, dim: agentsRunning === 0, text: `▶${agentsRunning} agents` },
  ]
  const used = 3 + chips.reduce((n, c) => n + c.text.length, 0) + tail.length
  const job = focusJob(s.jobs)
  let focus = ''
  if (job) {
    const meta = [job.progress, job.failures > 0 ? `×${job.failures}` : '', elapsed(s.now - job.startedAt)]
      .filter(Boolean)
      .join(' ')
    const room = width - used
    focus = fit(` │ ▶ ${fit(nameOf(job), Math.max(4, room - meta.length - 8))} · ${meta}`, room)
  }
  return (
    <Button key="band" onPress={act.togglePane}>
      <Text bold color="claude">bg </Text>
      {chips.map(c => (
        <Text color={c.tone && color(c.tone)} dimColor={c.dim}>
          {c.text}
        </Text>
      ))}
      <Text color={color('running')}>{focus}</Text>
      <Text dimColor>{tail}</Text>
    </Button>
  )
}

// ---------------------------------------------------------------- pane

function jobDetail(kit: Kit, job: Job, s: Snapshot, width: number, act: Actions) {
  const { Box, Button, Text } = kit
  const line = (label: string, value: string) => <Text dimColor>{fit(`    ${label.padEnd(6)}${value}`, width)}</Text>
  const exit = job.exitCode === undefined ? '' : `   exit ${job.exitCode}`
  return (
    <Box flexDirection="column">
      {line('cmd', job.command)}
      {line('out', job.path || '(no output file found)')}
      {job.lastLine !== '' && line('last', job.lastLine)}
      {line('start', `${elapsed(s.now - job.startedAt)} ago${exit}`)}
      <Box flexDirection="row">
        <Text>{'    '}</Text>
        {isLive(job) && <Button key={`stop-${job.id}`} plain label="[stop]" onPress={() => act.stop(job.id)} />}
        {isLive(job) && <Text>{'  '}</Text>}
        {job.path !== '' && (
          <Button key={`copy-${job.id}`} plain label="[copy path]" onPress={press => act.copy(job.path, press)} />
        )}
      </Box>
    </Box>
  )
}

function jobRow(kit: Kit, job: Job, s: Snapshot, width: number, act: Actions) {
  const { Box, Button, Text } = kit
  const open = s.view.expanded.includes(job.id)
  const tone = toneOf(job.status)
  const text = rowText(open ? '▾' : '▸', mark(job.status), nameOf(job), jobFigures(job, s.now, s.staleMs), width)
  return (
    <Box flexDirection="column">
      <Button key={job.id} onPress={() => act.toggle(job.id)}>
        <Text color={color(tone)} dimColor={tone === 'stopped'}>
          {text}
        </Text>
      </Button>
      {open && jobDetail(kit, job, s, width, act)}
    </Box>
  )
}

function agentRow(kit: Kit, row: AgentRow, s: Snapshot, width: number, act: Actions) {
  const { Box, Button, Text } = kit
  const key = `agent-${row.id}`
  const open = s.view.expanded.includes(key)
  const running = isRunningAgent(row, s.roster)
  const figures = [
    `${shortModel(row.model)}@${shortEffort(row.effort)}`,
    `${row.steps} st`,
    elapsed((running ? s.now : row.lastAt) - row.firstAt),
  ]
  const text = rowText(open ? '▾' : '▸', running ? '▶' : '·', agentName(row, s.roster), figures, width)
  const line = (label: string, value: string) => <Text dimColor>{fit(`    ${label.padEnd(6)}${value}`, width)}</Text>
  const cost = s.roster.get(row.id)?.cost?.usd ?? row.costUsd
  const out = outOf(row, s.roster)
  return (
    <Box flexDirection="column">
      <Button key={key} onPress={() => act.toggle(key)}>
        <Text color={running ? color('running') : undefined} dimColor={!running}>
          {text}
        </Text>
      </Button>
      {open && (
        <Box flexDirection="column">
          {line('model', `${shortModel(row.model)}@${row.effort}  ${row.steps} steps`)}
          {line('id', row.id)}
          {(out > 0 || cost !== undefined) &&
            line('usage', [out > 0 ? `${tokens(out)} out` : '', cost === undefined ? '' : `$${cost.toFixed(2)}`].filter(Boolean).join('   '))}
          {line('state', running ? `running ${elapsed(s.now - row.firstAt)}` : `finished ${elapsed(s.now - row.lastAt)} ago`)}
          <Box flexDirection="row">
            <Text>{'    '}</Text>
            <Button key={`view-${row.id}`} plain label="[view transcript]" onPress={() => act.viewAgent(row.id)} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** `  ▸ done 7  ✓5 ✗1 ■1`: a folded group of finished rows. */
function doneHeader(kit: Kit, id: string, open: boolean, count: number, parts: { tone: Tone; text: string }[], act: Actions) {
  const { Button, Text } = kit
  return (
    <Button key={`sec-${id}`} onPress={() => act.toggle(id)}>
      <Text dimColor>{`  ${open ? '▾' : '▸'} done ${count}  `}</Text>
      {parts.map(p => (
        <Text color={color(p.tone)} dimColor={p.tone === 'stopped'}>
          {p.text}{' '}
        </Text>
      ))}
    </Button>
  )
}

function jobsSection(kit: Kit, s: Snapshot, width: number, act: Actions) {
  const { Box, Button, Text } = kit
  const open = !s.view.collapsed.includes(SECTION.jobs)
  const live = s.jobs.filter(isLive).sort((a, b) => b.startedAt - a.startedAt)
  const done = s.jobs.filter(isDone).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const counts = (['running', 'ok', 'bad', 'stopped', 'unknown'] as const)
    .map(tone => ({ tone, n: s.jobs.filter(job => toneOf(job.status) === tone).length }))
    .filter(c => c.n > 0)
    .map(c => `${TONE_GLYPH[c.tone]}${c.n}`)
    .join(' ')
  const buttons = '  [clear]  [x] '
  const doneOpen = !s.view.collapsed.includes(SECTION.jobsDone)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="sec-jobs" onPress={() => act.toggle(SECTION.jobs)}>
          <Text bold>{pad(`${open ? '▾' : '▸'} Jobs  ${counts}`, width - buttons.length)}</Text>
        </Button>
        <Text>{'  '}</Text>
        <Button key="clear" plain dimColor label="[clear]" onPress={act.clear} />
        <Text>{'  '}</Text>
        <Button key="close" plain dimColor role="dismiss" label="[x]" onPress={act.close} />
      </Box>
      {open && live.length === 0 && <Text dimColor>  none running</Text>}
      {open && live.map(job => jobRow(kit, job, s, width, act))}
      {open &&
        done.length > 0 &&
        doneHeader(kit, SECTION.jobsDone, doneOpen, done.length, totalsParts(tallyOf(EMPTY_TALLY, done, 0)), act)}
      {open && doneOpen && done.map(job => jobRow(kit, job, s, width, act))}
    </Box>
  )
}

function agentsSection(kit: Kit, s: Snapshot, width: number, act: Actions) {
  const { Box, Button, Text } = kit
  const open = !s.view.collapsed.includes(SECTION.agents)
  const rows = subagents(s)
  const live = rows.filter(row => isRunningAgent(row, s.roster)).reverse()
  const done = rows.filter(row => !isRunningAgent(row, s.roster)).reverse()
  const main = s.agents.find(row => row.id === 'main')
  const mainText = main ? `main ${shortModel(main.model)}@${shortEffort(main.effort)}` : ''
  const doneOpen = !s.view.collapsed.includes(SECTION.agentsDone)
  return (
    <Box flexDirection="column">
      <Button key="sec-agents" onPress={() => act.toggle(SECTION.agents)}>
        <Text bold>{pad(`${open ? '▾' : '▸'} Agents  ▶${live.length}`, width - mainText.length)}</Text>
        <Text dimColor>{fit(mainText, width)}</Text>
      </Button>
      {open && live.length === 0 && <Text dimColor>  none running</Text>}
      {open && live.map(row => agentRow(kit, row, s, width, act))}
      {open && done.length > 0 && doneHeader(kit, SECTION.agentsDone, doneOpen, done.length, [], act)}
      {open && doneOpen && done.map(row => agentRow(kit, row, s, width, act))}
    </Box>
  )
}

/** The idle header: the state first, the session's totals under it. */
function idleHeader(kit: Kit, s: Snapshot, width: number) {
  const { Box, Text } = kit
  const parts = totalsParts(s.totals)
  const last = s.totals.lastAt === undefined ? '' : ` · last ${elapsed(s.now - s.totals.lastAt)} ago`
  const used = 'session  jobs '.length + parts.reduce((n, p) => n + p.text.length + 1, 0)
  return (
    <Box flexDirection="column">
      <Text bold dimColor>{fit('Idle · nothing running', width)}</Text>
      <Box flexDirection="row">
        <Text dimColor>session  jobs </Text>
        {parts.map(p => (
          <Text color={color(p.tone)}>{p.text} </Text>
        ))}
        <Text dimColor>{fit(`· agents ${s.totals.agents}${last}`, width - used)}</Text>
      </Box>
      <Text> </Text>
    </Box>
  )
}

export function paneBody(kit: Kit, s: Snapshot, width: number, act: Actions) {
  const { Box, Button, Text } = kit
  const idle = !s.jobs.some(job => job.status === 'running') && !subagents(s).some(row => isRunningAgent(row, s.roster))
  const viewing = s.viewingAgent === undefined ? undefined : s.agents.find(row => row.id === s.viewingAgent)
  return (
    <Box flexDirection="column">
      {s.viewingAgent !== undefined && (
        <Button key="back" onPress={act.back}>
          <Text color={color('running')}>
            {fit(`← back to main   viewing ${viewing ? agentName(viewing, s.roster) : s.viewingAgent}`, width)}
          </Text>
        </Button>
      )}
      {idle && idleHeader(kit, s, width)}
      {jobsSection(kit, s, width, act)}
      <Text> </Text>
      {agentsSection(kit, s, width, act)}
    </Box>
  )
}
