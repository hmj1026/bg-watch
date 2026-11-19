import { expect, test } from 'claude-code/testing'

import type { Job } from '../types'
import { EMPTY_TALLY, focusJob, jobFigures, nameOf, rowText, stripPoll, toneOf, totalsOf, totalsParts } from './layout'

const job = (over: Partial<Job>): Job => ({
  id: 'b1',
  kind: 'bash',
  command: 'npm test',
  description: '',
  path: '/tmp/tasks/b1.output',
  startedAt: 0,
  updatedAt: 0,
  status: 'running',
  bytes: 0,
  failures: 0,
  oks: 0,
  lastLine: '',
  ...over,
})

test('a row never runs past its width', () => {
  const name = 'Rerun per-site mutation coverage check across every site'
  for (const width of [24, 40, 60, 100]) {
    const row = rowText('▸', '▶', name, ['41/262', '×1', 'quiet 2m00s', '9m44s'], width)
    expect(row.length).toBeLessThanOrEqual(width)
    expect(row).toContain('9m44s')
  }
})

test('a narrow row drops the leading figures before the elapsed time', () => {
  const row = rowText('▸', '▶', 'e2e suite', ['41/262', '×1', '9m44s'], 24)
  expect(row).toContain('9m44s')
  expect(row).not.toContain('41/262')
})

test('a poll loop reads as what it waits for', () => {
  expect(stripPoll('until grep -q "^EXIT" /tmp/x/tasks/b9m4.output; do sleep 5; done')).toBe('wait for b9m4')
  expect(stripPoll('while true; do date; done')).toBe('wait: true')
  expect(stripPoll('npm test')).toBe('npm test')
  expect(nameOf(job({ description: 'Run tests' }))).toBe('Run tests')
  expect(nameOf(job({ kind: 'monitor', description: 'watch CI' }))).toBe('mon watch CI')
})

test('the band only ever names a running job', () => {
  const failed = job({ id: 'f', status: 'failed', endedAt: 10 })
  expect(focusJob([failed])).toBe(undefined)
  const old = job({ id: 'old', startedAt: 0 })
  const withProgress = job({ id: 'p', startedAt: 5, progress: '3/9' })
  expect(focusJob([failed, old, withProgress])?.id).toBe('p')
  expect(focusJob([failed, old])?.id).toBe('old')
})

test('the states read as tones', () => {
  expect(['running', 'completed', 'failed', 'killed', 'ended', 'unknown'].map(toneOf)).toEqual([
    'running',
    'ok',
    'bad',
    'stopped',
    'stopped',
    'unknown',
  ])
})

test('quiet shows only once output has come, and never equals the elapsed time', () => {
  expect(jobFigures(job({}), 600_000, 60_000)).toEqual(['no output yet', '10m00s'])
  expect(jobFigures(job({ bytes: 9, updatedAt: 300_000 }), 600_000, 60_000)).toEqual(['quiet 5m00s', '10m00s'])
  expect(jobFigures(job({ status: 'failed', exitCode: 2, endedAt: 60_000 }), 600_000, 60_000)).toEqual([
    'exit 2',
    '1m00s',
  ])
})

test('the totals count what was cleared as well as what is listed', () => {
  const totals = totalsOf(
    { ...EMPTY_TALLY, completed: 2 },
    [job({ status: 'completed', endedAt: 5 }), job({ status: 'failed', endedAt: 9 }), job({})],
    [],
  )
  expect(totals).toEqual({ completed: 3, failed: 1, stopped: 0, agents: 0, lastAt: 9 })
  expect(totalsParts(totals).map(part => part.text)).toEqual(['✓3', '✗1'])
})

test('wide characters take two cells, so a Chinese name still fits', () => {
  const row = rowText('▸', '▶', '全套測試修正與合併到整合分支', ['41/262', '9m44s'], 30)
  let n = 0
  for (const ch of row) n += /[一-鿿]/.test(ch) ? 2 : 1
  expect(n).toBeLessThanOrEqual(30)
  expect(row).toContain('9m44s')
})
