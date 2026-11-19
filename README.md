# bg-watch

English | [繁體中文](README.zh-TW.md)

A Claude Code mod that shows, live, in a band above the prompt, in a pane, and under each tool call in the
transcript:

- background Bash commands, Monitors and Workflows: progress, failure count, last output line, elapsed time,
  quiet warning, and how each one ended (exit code included)
- the model@effort each subagent actually sent (and the main agent's), with its output tokens and cost

## At a glance

### The band above the prompt

While something runs, one line counts the jobs and agents and names one running job (one with progress
first, else the longest running):

```
bg ▶3 jobs  ✗1 failed  ?1  ▶2 agents │ ▶ Full e2e suite · 41/262 ×1 9m02s  [open]
❯ _
```

Once nothing runs, it turns into a dim summary of the session. It never keeps showing the last job:

```
bg idle · jobs ✓5 ✗1 ■1 · 10 agents done · last activity 3m12s ago  [open]
❯ _
```

Before anything has run, the band takes no row. Click the line to open the pane, and click it again to
close it. The engine's own `[-]` folds the band.

### The pane

Docked beside the transcript, or inline above the prompt. Every row is one line, laid out to the pane's
width. Drag the pane's edge to resize it and the rows lay out again.

```
▾ Jobs  ▶2 ✓4 ✗1 ?1                     [clear]  [x]
▸ ▶ Full e2e suite          41/262  ×1  9m02s
▾ ▶ Rerun mutation check     no output yet  9m44s
    cmd   npm run mutation -- --site tw,hk,sg
    out   /tmp/claude-1000/…/tasks/b9m4.output
    start 9m44s ago
    [stop]  [copy path]
▸ ? Implement #1495 tests   no output file  45m00s
  ▸ done 6  ✓4 ✗1 ■1

▾ Agents  ▶2                main opus-5-5@med
▸ ▶ dhpk:security-reviewer  Security review…  opus-5-5@high  53 st  21m16s
▸ ▶ general-purpose  Diagnose workflow…  sonnet-5-5@med  159 st  45m02s
  ▸ done 10
```

With nothing running, the pane opens with the state and the session's totals:

```
Idle · nothing running
session  jobs ✓5 ✗1 ■1 · agents 10 · last 3m12s ago
```

### What you can click

| Where | Click | Does |
| --- | --- | --- |
| Band | the line | Open or close the pane |
| Pane | a job or agent row | Unfold or fold its details |
| Pane | `Jobs`, `Agents`, `done N` | Fold or unfold that group (finished groups start folded) |
| Job details | `[stop]` | Stop the job through TaskStop |
| Job details | `[copy path]` | Copy the output file's path |
| Agent details | `[view transcript]` | Show that agent's transcript in the main view |
| Pane top | `← back to main` | Return to the main conversation |
| Pane header | `[clear]` | Drop finished rows (the session totals keep counting them) |
| Pane header | `[x]` | Close the pane |

### Legend

| Mark | State | Color |
| --- | --- | --- |
| `▶` | running (a job, or an agent still alive) | accent |
| `✓` | completed | green |
| `✗` | failed, with its exit code | red |
| `■` | stopped: `killed`, `stopped`, `ended` (exited with no notification), `expired` (a Monitor past its timeout) | dim |
| `?` | unknown: a Bash job whose output file never turned up; not counted as running | yellow |
| `·` | a finished agent | dim |
| `▸` / `▾` | folded / unfolded row or group | |
| `×N` | failures seen so far (TAP `not ok`, or a runner's summary) | |

## Commands

| Command | Does |
| --- | --- |
| `/bg-watch` | Open the pane |
| `/bg-watch close` | Close the pane |
| `/bg-watch clear` | Drop finished rows now |

## What it reads

Progress, most specific first: a TAP plan (`1..N` with `ok` / `not ok` lines), a jest or vitest `Tests:` summary,
pytest's `[ 45%]`, a percent at a line's end, then a standalone `N/M` (dates and paths such as `2026/11/18` or
`src/1/2` are skipped). ANSI color codes are stripped from the last output line.

A job ends when its task notification arrives, when it is stopped with TaskStop, or:

- a Bash job with no notification (a subagent's job, a missed delivery): once its output has been quiet and `lsof`
  shows nothing holds the output file any more, shown as `■ ended` (exit code unknown)
- a Monitor: past its own timeout, shown as `■ expired`

A Bash job whose output file never turned up is shown as `? unknown` after `staleSec` and is not counted as
running; its notification still ends it, and it ends by itself after `finishedTtlSec`. Finished jobs and idle
subagent rows leave the pane on their own. A job that ran long sends a system notification when it ends.

## Settings

In `/config`, or `pluginConfigs["bg-watch"].options` in settings.json:

| Field | Default | What it does |
| --- | --- | --- |
| `finishedTtlSec` | 1800 | How long a finished job or idle subagent row stays listed under `done` |
| `quietCheckSec` | 10 | Output quiet this long: check with `lsof` whether a Bash job has exited |
| `staleSec` | 60 | Show `quiet …` on a running job whose output has not grown for this long |
| `notifyAfterSec` | 120 | System notification when a job that ran this long ends; `0` turns it off |
| `band` | true | The clickable summary line above the prompt |
| `statusLine` | false | Also show running jobs in the status line |

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install bg-watch --marketplace hmj1026/bg-watch
```

Answer `y` to add the marketplace, then pick a scope.

Or from a shell:

```bash
claude plugin marketplace add hmj1026/bg-watch
claude plugin install bg-watch@bg-watch            # add -s project or -s local for another scope
```

Restart Claude Code (or start a new session), then run `/bg-watch` to open the pane.

## Update

Refresh the marketplace, then update the plugin, and restart Claude Code to load the new version:

```bash
claude plugin marketplace update bg-watch
claude plugin update bg-watch@bg-watch
```

Inside a session, `/plugin` opens the same marketplace and plugin manager. `claude plugin list` shows the
installed version.

## Uninstall

```bash
claude plugin uninstall bg-watch@bg-watch
claude plugin marketplace remove bg-watch          # optional: drop the marketplace too
```

## Develop

```bash
claude --plugin-dir ~/projects/bg-watch            # a session with the working copy loaded
claude plugin test .                               # run the tests
claude plugin validate .                           # check the manifest and hooks module
```
