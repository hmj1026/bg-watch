# bg-watch

A Claude Code mod that shows, live, in a pane and the status line:

- progress of background Bash commands (`N/M`, `not ok` count, last output line, elapsed time, quiet warning)
- the model@effort each subagent actually sent (and the main agent's)

Open the pane with `/bg-watch`; `/bg-watch close` closes it; `/bg-watch clear` drops finished rows.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install bg-watch --marketplace hmj1026/bg-watch
```

Answer `y` to add the marketplace, then pick a scope.
