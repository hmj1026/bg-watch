import { expect, test } from 'claude-code/testing'

import { notificationOf, outputPathOf, progressOf, readPiece, tasksDirOf, tokens } from './parse'

test('the output path is read off the model text, stdout as a fallback', () => {
  const text =
    'Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output. You will be notified.'
  expect(outputPathOf(text, '')).toBe('/tmp/x/tasks/b1.output')
  expect(outputPathOf(undefined, text)).toBe('/tmp/x/tasks/b1.output')
  expect(outputPathOf('', undefined)).toBe('')
  expect(tasksDirOf('/tmp/x/tasks/b1.output')).toBe('/tmp/x/tasks')
  expect(tasksDirOf('/tmp/x/other.log')).toBe('')
})

test('a notification gives its id, status, file and exit code', () => {
  const note = notificationOf(
    '<task-notification>\n<task-id>b9</task-id>\n<output-file>/t/b9.output</output-file>\n<status>failed</status>\n<summary>Background command "npm test" failed with exit code 144</summary>\n</task-notification>',
  )
  expect(note).toEqual({ id: 'b9', status: 'failed', path: '/t/b9.output', exitCode: 144 })
  const ok = notificationOf(
    '<task-id>b8</task-id><status>completed</status><summary>Background command "x" completed (exit code 0)</summary>',
  )
  expect(ok?.exitCode).toBe(0)
  expect(notificationOf('<task-id>a1</task-id><status>completed</status><summary>Agent "x" finished</summary>')?.exitCode).toBe(undefined)
  expect(notificationOf('<task-id>a1</task-id>')).toBe(undefined)
})

test('test runner summaries win over loose figures', () => {
  expect(progressOf('Tests:       2 failed, 8 passed, 10 total\n')).toEqual({ progress: '10/10', failures: 2 })
  expect(progressOf('Tests: 3 passed, 12 total\n')).toEqual({ progress: '3/12', failures: 0 })
  expect(progressOf(' Tests  1 failed | 9 passed (10)\n')).toEqual({ progress: '10/10', failures: 1 })
  expect(progressOf('tests/test_a.py ....                [ 45%]\n')).toEqual({ progress: '45%' })
  expect(progressOf('Downloading… 37.5%\n')).toEqual({ progress: '37.5%' })
  expect(progressOf('building (12/40)\n')).toEqual({ progress: '12/40' })
})

test('dates, paths and impossible ratios are not progress', () => {
  expect(progressOf('2026/11/18 build started\n')).toEqual({})
  expect(progressOf('reading src/1/2/index.ts\n')).toEqual({})
  expect(progressOf('ratio 9/4\n')).toEqual({})
  expect(progressOf('v1.2/3\n')).toEqual({})
})

test('a piece of TAP output counts ok, not ok and the plan', () => {
  const piece = readPiece('TAP version 13\n1..5\nok 1 a\nnot ok 2 b\nok 3 c\n')
  expect(piece.oks).toBe(2)
  expect(piece.failures).toBe(1)
  expect(piece.plan).toBe(5)
  expect(piece.lastLine).toBe('ok 3 c')
})

test('token counts read short', () => {
  expect(tokens(950)).toBe('950')
  expect(tokens(12_345)).toBe('12.3k')
  expect(tokens(2_500_000)).toBe('2.5M')
})

test('the last line drops ANSI color codes and control characters', () => {
  expect(readPiece('\u001b[32mPASS\u001b[0m src/a.test.ts\r\n').lastLine).toBe('PASS src/a.test.ts')
})
