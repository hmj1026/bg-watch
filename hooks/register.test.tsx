import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PATH = '/tmp/tasks/b1.output'

const PANE = {
  plugin: 'bg-watch',
  component: 'Pane',
  requestId: 'bg-watch',
  surface: 'terminal',
  props: {
    title: 'Background & agents',
    isFocused: false,
    bodyColumns: 160,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PROCESS = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/**
 * The engine beneath bg-watch: tool calls answered as core does (a background
 * Bash call's path only in the model's text), an output file whose text the
 * test sets, an `lsof` that says whether anything holds it, and records of the
 * status line, TaskStop calls and OS notifications.
 */
function world(on: On, agents: AgentInfo[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const file = { text: '', held: true }
  const status: (string | undefined)[] = []
  const stops: string[] = []
  const notes: string[] = []
  const copies: string[] = []
  const views: string[] = []
  /** What a background Bash call answers: its id, and whether the model text names its file. */
  const bash = { id: 'b1', withPath: true }

  on('command.register', () => ({ value: { command: 'bg-watch' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('ui.view', (_, e) => {
    views.push(e.agentId ?? 'main')
    return { value: {} }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notes.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } as const }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskStop') {
      stops.push(String(e.task_id))
      return { result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_bash' } }
    }
    if (e.tool === 'Monitor') return { result: { taskId: 'm1', timeoutMs: 60_000 } }
    if (e.tool === 'Workflow') {
      return { result: { status: 'async_launched', taskId: 'w1', workflowName: 'review-changes' } }
    }
    return {
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: bash.id },
      text: bash.withPath
        ? `Command running in background with ID: ${bash.id}. Output is being written to: ${PATH}. You will be notified when it completes.`
        : `Command running in background with ID: ${bash.id}.`,
    }
  })
  on('fs.stat', (_, e) => {
    if (e.path !== PATH) throw new Error('ENOENT')
    return { value: { kind: 'file', size: new TextEncoder().encode(file.text).length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => ({
    value: new TextDecoder().decode(
      new TextEncoder().encode(file.text).slice(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? 1e9)),
    ),
  }))
  on('fs.exists', (_, e) => ({ value: e.path === PATH }))
  on('process.run', () => ({
    value: file.held ? { exitCode: 0, stdout: '4242\n', ...PROCESS } : { exitCode: 1, stdout: '', ...PROCESS },
  }))
  on('agent.list', () => ({ value: agents }))
  return { clock, file, status, stops, notes, copies, views, bash }
}

const notify = (status: string, summary = '', id = 'b1') => ({
  text: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  origin: { kind: 'task-notification' } as const,
  wait: false,
})

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'toolu_b1',
    command: 'npm test',
    description: 'Run tests',
    run_in_background: true,
  })
}

/** A row's text in the pane; `done` unfolds the finished jobs first. */
const rowText = async ($: Engine, pattern: RegExp, done = false) => {
  const ui = await $.ui.mount(PANE)
  if (done && (await ui.find({ key: 'sec-jobs-done' }))) await ui.press({ key: 'sec-jobs-done' })
  const text = (await ui.find({ type: 'Text', text: pattern }))?.text
  if (done && (await ui.find({ key: 'sec-jobs-done' }))) await ui.press({ key: 'sec-jobs-done' })
  await ui.unmount()
  return text
}

test('a background job reads its output path off the model text and shows progress', { options: { statusLine: true } }, async ($, on) => {
  const { clock, file, status } = world(on)
  await start($)

  file.text = 'ok 1 a\nnot ok 2 b\nrunning 2/5\n'
  await clock.advance(3000)

  const row = await rowText($, /Run tests/)
  expect(row).toContain('2/5')
  expect(row).toContain('×1')
  expect(status.at(-1)).toContain('Run tests 2/5')
})

test('a TAP plan gives progress across polls', async ($, on) => {
  const { clock, file } = world(on)
  await start($)

  file.text = '1..4\nok 1 a\n'
  await clock.advance(3000)
  file.text += 'ok 2 b\nnot ok 3 c\n'
  await clock.advance(3000)

  const row = await rowText($, /Run tests/)
  expect(row).toContain('3/4')
  expect(row).toContain('×1')
})

test('a task notification ends the job, with its exit code, and clears the status line', { options: { statusLine: true } }, async ($, on) => {
  const { status, notes } = world(on)
  await start($)

  await $.prompt.submit(notify('failed', 'Background command "npm test" failed with exit code 2'))

  expect(await rowText($, /Run tests/)).toBe(undefined) // folded under done
  const row = await rowText($, /Run tests/, true)
  expect(row).toMatch(/^▸ ✗/)
  expect(row).toContain('exit 2')
  expect(status.at(-1)).toBe(undefined)
  expect(notes).toEqual([]) // a short job sends no OS notification
})

test('a long job sends an OS notification when it ends', async ($, on) => {
  const { clock, notes } = world(on)
  await start($)

  await clock.advance(150_000)
  await $.prompt.submit(notify('completed', 'Background command "npm test" completed (exit code 0)'))

  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Run tests completed')
})

test('the OS notification can be turned off', { options: { notifyAfterSec: 0 } }, async ($, on) => {
  const { clock, notes } = world(on)
  await start($)

  await clock.advance(150_000)
  await $.prompt.submit(notify('completed'))

  expect(notes).toEqual([])
})

test('a quiet job whose output file nothing holds is marked ended without a notification', { options: { statusLine: true } }, async ($, on) => {
  const { clock, file, status } = world(on)
  await start($)

  file.text = 'done\n'
  await clock.advance(3000)
  await clock.advance(15_000)
  expect(status.at(-1)).toContain('Run tests') // still held: still running

  file.held = false
  await clock.advance(12_000)

  expect(await rowText($, /Run tests/, true)).toMatch(/^▸ ■/)
  expect(status.at(-1)).toBe(undefined)
})

test('a finished job leaves the pane after a while, and still counts', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit(notify('failed'))

  await clock.advance(31 * 60_000)

  expect(await rowText($, /Run tests/, true)).toBe(undefined)
  expect(await rowText($, /^session/)).toBeDefined()
  expect(await rowText($, /✗1/)).toBe('✗1 ')
})

test('how long finished rows stay is a setting', { options: { finishedTtlSec: 60 } }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit(notify('failed'))

  await clock.advance(2 * 60_000)

  expect(await rowText($, /Run tests/, true)).toBe(undefined)
})

test('the status line can be turned off', { options: { statusLine: false } }, async ($, on) => {
  const { status } = world(on)
  await start($)

  expect(status.every(text => text === undefined)).toBe(true)
})

test('the pane stops a running job through TaskStop', async ($, on) => {
  const { stops } = world(on)
  await start($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'stop-b1' })).toBe(undefined) // inside the folded row
  await ui.press({ key: 'b1' })
  await ui.press({ key: 'stop-b1' })
  expect(stops).toEqual(['b1'])
  expect(await ui.find({ key: 'stop-b1' })).toBe(undefined)
  await ui.press({ key: 'sec-jobs-done' })
  expect((await ui.find({ type: 'Text', text: /Run tests/ }))?.text).toMatch(/killed/)
  await ui.unmount()
})

test('the tool call row in the transcript shows the job reading', async ($, on) => {
  const { clock, file } = world(on)
  await start($)
  file.text = 'building (12/40)\n'
  await clock.advance(3000)

  const ui = await $.ui.mount({
    plugin: 'bg-watch',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      tool_use_id: 'toolu_b1',
      tool: 'Bash',
      input: { command: 'npm test' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })
  const line = (await ui.find({ type: 'Text', text: /⎿/ }))?.text
  expect(line).toContain('▶')
  expect(line).toContain('12/40')
  await ui.unmount()
})

test('a Monitor is a job that expires past its deadline', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Monitor', description: 'watch CI', timeout_ms: 60_000, command: 'gh run watch' })

  expect(await rowText($, /watch CI/)).toMatch(/^▸ ▶ mon watch CI/)
  await clock.advance(60_000 + 33_000)
  expect(await rowText($, /watch CI/, true)).toMatch(/^▸ ■ mon watch CI.*expired/)
})

test('a Workflow is a job that ends on its notification', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })

  expect(await rowText($, /review-changes/)).toMatch(/^▸ ▶ wf review-changes/)
  await $.prompt.submit(notify('completed', '', 'w1'))
  expect(await rowText($, /review-changes/, true)).toMatch(/^▸ ✓ wf review-changes/)
})

test('a subagent row shows its output tokens and cost', async ($, on) => {
  const { clock } = world(on, [
    {
      id: 'a1',
      type: 'Explore',
      description: 'find callers',
      status: 'running',
      kind: 'local_agent',
      usage: [
        { model: 'claude-haiku-5-5', input_tokens: 900, output_tokens: 12_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { model: 'claude-haiku-5-5', input_tokens: 900, output_tokens: 345, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
      cost: { usd: 0.0412 },
    } as AgentInfo,
  ])
  // The model's answer to the step: an empty one, ended.
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' })
  for await (const _ of stream) {
    // drain
  }
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /find callers/ }))?.text).toContain('haiku-5-5@low')
  await ui.press({ key: 'agent-a1' })
  const usage = (await ui.find({ type: 'Text', text: /usage/ }))?.text
  expect(usage).toContain('12.3k out')
  expect(usage).toContain('$0.04')
  await ui.unmount()
})

const BAND = {
  plugin: 'bg-watch',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount(BAND)
  const button = await ui.find({ key: 'band' })
  const texts = button ? (await ui.findAll({ type: 'Text' })).map(one => one.text).join('') : undefined
  await ui.unmount()
  return texts
}

test('the band counts running jobs and names one, within its width', async ($, on) => {
  const { clock, file } = world(on)
  await start($)
  file.text = 'running 2/5\n'
  await clock.advance(3000)

  const text = await bandText($)
  expect(text).toContain('▶1 jobs')
  expect(text).toContain('▶ Run tests · 2/5')
  expect(text).toContain('[open]')
  expect(text!.length).toBeLessThanOrEqual(100)
})

test('with nothing running the band is a summary, never the last job', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit(notify('failed', 'failed with exit code 1'))

  const text = await bandText($)
  expect(text).toContain('bg idle')
  expect(text).toContain('✗1')
  expect(text).not.toContain('Run tests')
})

test('before anything ran the band takes no row', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await bandText($)).toBe(undefined)
})

test('a press on the band opens the pane and the next closes it', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'band' })
  expect((await ui.find({ type: 'Text', text: /close/ }))?.text).toContain('[close]')
  await ui.press({ key: 'band' })
  expect((await ui.find({ type: 'Text', text: /open/ }))?.text).toContain('[open]')
  await ui.unmount()
})

test('a pressed row unfolds its details and copies its path', async ($, on) => {
  const { copies } = world(on)
  await start($)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /cmd/ })).toBe(undefined)
  await ui.press({ key: 'b1' })
  expect((await ui.find({ type: 'Text', text: /cmd/ }))?.text).toContain('npm test')
  await ui.press({ key: 'copy-b1' })
  expect(copies).toEqual([PATH])
  await ui.press({ key: 'b1' })
  expect(await ui.find({ type: 'Text', text: /cmd/ })).toBe(undefined)
  await ui.unmount()
})

test('a Bash job whose output file never turns up stops counting as running', async ($, on) => {
  const { clock, bash } = world(on)
  bash.id = 'b2'
  bash.withPath = false
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b2', command: 'make', description: 'Build', run_in_background: true })

  await clock.advance(63_000)

  expect(await rowText($, /Build/)).toMatch(/^▸ \? Build.*no output file/)
  expect(await bandText($)).toContain('bg idle · jobs ?1') // not counted as running
  await $.prompt.submit(notify('completed', '', 'b2'))
  expect(await rowText($, /Build/, true)).toMatch(/^▸ ✓ Build/)
})

test('a finished subagent keeps its name, and its row opens its transcript', async ($, on) => {
  const roster: AgentInfo[] = [
    { id: 'a1', type: 'Explore', description: 'find callers', status: 'running', kind: 'local_agent', usage: [] } as unknown as AgentInfo,
  ]
  const { clock, views } = world(on, roster)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' })) {
    // drain
  }
  await clock.advance(3000)
  roster.length = 0 // finished: gone from the roster

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'sec-agents-done' })
  expect((await ui.find({ type: 'Text', text: /find callers/ }))?.text).toMatch(/^▸ · Explore {2}find callers/)
  await ui.press({ key: 'agent-a1' })
  await ui.press({ key: 'view-a1' })
  expect(views).toEqual(['a1'])
  await ui.unmount()
})

test('[clear] keeps a job still unknown, and counts what it drops', async ($, on) => {
  const { clock, bash } = world(on)
  await start($)
  await $.prompt.submit(notify('completed'))
  bash.id = 'b2'
  bash.withPath = false
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b2', command: 'make', description: 'Build', run_in_background: true })
  await clock.advance(63_000)

  await $.command.run({
    command: 'bg-watch',
    args: 'clear',
    origin: { kind: 'plugin', name: 'test' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(await rowText($, /Build/)).toMatch(/^▸ \? Build/)
  expect(await rowText($, /Run tests/, true)).toBe(undefined)
  expect(await bandText($)).toContain('✓1')
})

test('an idle subagent is still alive, not done', async ($, on) => {
  const roster = [
    { id: 'a1', type: 'Explore', description: 'find callers', status: 'idle', kind: 'local_agent', usage: [] } as unknown as AgentInfo,
  ]
  const { clock } = world(on, roster)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' })) {
    // drain
  }
  await clock.advance(3000)

  expect(await rowText($, /find callers/)).toMatch(/^▸ ▶ Explore/)
  expect(await bandText($)).toContain('▶1 agents')
})
