# bg-watch

English | [繁體中文](README.zh-TW.md)

A Claude Code mod that shows, live, in a pane, under each tool call in the transcript, and in the status line:

- background Bash commands, Monitors and Workflows: progress, `not ok` count, last output line, elapsed time,
  quiet warning, and how each one ended (exit code included)
- the model@effort each subagent actually sent (and the main agent's), with its output tokens and cost

Open the pane with `/bg-watch`; `/bg-watch close` closes it; `/bg-watch clear` drops finished rows now.
Each running job in the pane has a `stop` button, which stops it through TaskStop.

## What it reads

Progress, most specific first: a TAP plan (`1..N` with `ok` / `not ok` lines), a jest or vitest `Tests:` summary,
pytest's `[ 45%]`, a percent at a line's end, then a standalone `N/M` (dates and paths such as `2026/11/18` or
`src/1/2` are skipped).

A job ends when its task notification arrives, when it is stopped with TaskStop, or:

- a Bash job with no notification (a subagent's job, a missed delivery): once its output has been quiet and `lsof`
  shows nothing holds the output file any more, shown as `■ ended` (exit code unknown)
- a Monitor: past its own timeout, shown as `■ expired`

Finished jobs and idle subagent rows leave the pane on their own. A job that ran long sends a system notification
when it ends.

## Settings

In `/config`, or `pluginConfigs["bg-watch"].options` in settings.json:

| Field | Default | What it does |
| --- | --- | --- |
| `finishedTtlSec` | 180 | How long a finished job or idle subagent row stays in the pane |
| `quietCheckSec` | 10 | Output quiet this long: check with `lsof` whether a Bash job has exited |
| `staleSec` | 60 | Show `(quiet …)` on a running job whose output has not grown for this long |
| `notifyAfterSec` | 120 | System notification when a job that ran this long ends; `0` turns it off |
| `statusLine` | true | Show running jobs in the status line |

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install bg-watch --marketplace hmj1026/bg-watch
```

Answer `y` to add the marketplace, then pick a scope.
