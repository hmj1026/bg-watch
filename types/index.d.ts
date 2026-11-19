export type JobStatus = 'running' | 'completed' | 'failed' | 'killed' | 'stopped' | 'ended' | 'expired' | string

/** What started the job: a background Bash call, a Monitor, a Workflow. */
export type JobKind = 'bash' | 'monitor' | 'workflow'

export type Job = {
  /** The background task id (Bash `backgroundTaskId`, Monitor/Workflow `taskId`). */
  id: string
  kind: JobKind
  /** The `tool_use_id` of the call that started it: the transcript row it belongs to. */
  toolUseId?: string
  /** The command line (a Workflow's name), clipped. */
  command: string
  /** The call's own description, when it gave one. */
  description: string
  /** The task's output file, when it could be found. */
  path: string
  startedAt: number
  /** Last time the output grew. */
  updatedAt: number
  endedAt?: number
  /** A Monitor's own expiry; past it (and a grace) the job is `expired`. */
  deadline?: number
  /**
   * `running` until the end is known: the notification's word
   * (`completed`, `failed`, `killed`, `stopped`), `ended` when bg-watch saw the
   * output file released with no notification (exit code unknown), `expired`
   * for a Monitor past its deadline, `unknown` for a Bash job whose output file
   * never turned up: not counted as running, still endable by a notification.
   */
  status: JobStatus
  /** The exit code a notification stated (`failed with exit code 1`). */
  exitCode?: number
  /** Output size in bytes seen at the last poll; the next read starts there. */
  bytes: number
  /** Progress as last read: `165/262`, `45%`. */
  progress?: string
  /** Failures seen so far: TAP `not ok` lines, or a runner summary's count. */
  failures: number
  /** TAP `ok` lines seen so far. */
  oks: number
  /** A TAP plan `1..N`, once seen. */
  plan?: number
  /** Last non-empty output line, clipped. */
  lastLine: string
}

export type AgentRow = {
  /** The subagent's id (`turn.step`'s `agentId`), or `main`. */
  id: string
  /** Model the engine actually sent on the latest step. */
  model: string
  /** Effort the engine actually sent on the latest step, `-` when none. */
  effort: string
  steps: number
  firstAt: number
  lastAt: number
  /** The agent type, kept from the roster so a finished agent keeps its name. */
  type?: string
  /** The task it was given, kept from the roster. */
  description?: string
  /** Output tokens and cost as the roster last stated them. */
  outTokens?: number
  costUsd?: number
}

/** Finished rows that left the lists (`[clear]`, expiry), so the totals outlive them. */
export type Tally = { completed: number; failed: number; stopped: number; agents: number }

/** What the person opened and closed in the pane: row ids and section ids. */
export type ViewState = { expanded: string[]; collapsed: string[] }

declare module 'claude-code' {
  interface PluginState {
    'bg-watch': {
      jobs: Shaped<Job[]>
      agents: Shaped<AgentRow[]>
      /** Finished rows no longer listed, counted. */
      tally: Shaped<Tally>
      /** Expanded rows and collapsed sections. */
      view: Shaped<ViewState>
      /** Whether the pane is open, for the band's [open]/[close]. */
      paneOpen: boolean
      /** Bumped each poll while a job runs, so the pane's elapsed times move. */
      tick: number
    }
  }
}
