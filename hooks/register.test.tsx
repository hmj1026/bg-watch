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

  on('command.register', () => ({ value: { command: 'bg-watch' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
      text: `Command running in background with ID: b1. Output is being written to: ${PATH}. You will be notified when it completes.`,
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
  return { clock, file, status, stops, notes }
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

const rowText = async ($: Engine, pattern: RegExp) => {
  const ui = await $.ui.mount(PANE)
  const text = (await ui.find({ type: 'Text', text: pattern }))?.text
  await ui.unmount()
  return text
}

test('a background job reads its output path off the model text and shows progress', async ($, on) => {
  const { clock, file, status } = world(on)
  await start($)

  file.text = 'ok 1 a\nnot ok 2 b\nrunning 2/5\n'
  await clock.advance(3000)

  const row = await rowText($, /Run tests/)
  expect(row).toContain('2/5')
  expect(row).toContain('not ok ×1')
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
  expect(row).toContain('not ok ×1')
})

test('a task notification ends the job, with its exit code, and clears the status line', async ($, on) => {
  const { status, notes } = world(on)
  await start($)

  await $.prompt.submit(notify('failed', 'Background command "npm test" failed with exit code 2'))

  const row = await rowText($, /Run tests/)
  expect(row).toMatch(/^✗/)
  expect(row).toContain('failed (exit 2)')
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

test('a quiet job whose output file nothing holds is marked ended without a notification', async ($, on) => {
  const { clock, file, status } = world(on)
  await start($)

  file.text = 'done\n'
  await clock.advance(3000)
  await clock.advance(15_000)
  expect(status.at(-1)).toContain('Run tests') // still held: still running

  file.held = false
  await clock.advance(12_000)

  expect(await rowText($, /Run tests/)).toMatch(/^■/)
  expect(status.at(-1)).toBe(undefined)
})

test('a finished job leaves the pane after a while', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit(notify('failed'))

  await clock.advance(4 * 60_000)

  expect(await rowText($, /Run tests/)).toBe(undefined)
})

test('how long finished rows stay is a setting', { options: { finishedTtlSec: 600 } }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit(notify('failed'))

  await clock.advance(4 * 60_000)

  expect(await rowText($, /Run tests/)).toMatch(/^✗/)
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
  await ui.press({ key: 'stop-b1' })
  expect(stops).toEqual(['b1'])
  expect((await ui.find({ type: 'Text', text: /Run tests/ }))?.text).toMatch(/killed/)
  expect(await ui.find({ key: 'stop-b1' })).toBe(undefined)
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

  expect(await rowText($, /watch CI/)).toMatch(/^▶ \[mon\]/)
  await clock.advance(60_000 + 33_000)
  expect(await rowText($, /watch CI/)).toMatch(/^■ \[mon\].*expired/)
})

test('a Workflow is a job that ends on its notification', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })

  expect(await rowText($, /review-changes/)).toMatch(/^▶ \[wf\]/)
  await $.prompt.submit(notify('completed', '', 'w1'))
  expect(await rowText($, /review-changes/)).toMatch(/^✓ \[wf\]/)
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

  const row = await rowText($, /find callers/)
  expect(row).toContain('haiku-5-5@low')
  expect(row).toContain('12.3k out')
  expect(row).toContain('$0.04')
})
