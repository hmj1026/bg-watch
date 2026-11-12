export type JobStatus = 'running' | 'completed' | 'failed' | 'killed' | string

export type Job = {
  /** The background task id (Bash result `backgroundTaskId`). */
  id: string
  /** The command line, clipped. */
  command: string
  /** The Bash call's own description, when it gave one. */
  description: string
  /** The task's output file, when it could be found. */
  path: string
  startedAt: number
  /** Last time the output grew. */
  updatedAt: number
  endedAt?: number
  status: JobStatus
  /** Output size seen at the last poll. */
  bytes: number
  /** Last `N/M` seen in the output, e.g. `165/262`. */
  progress?: string
  /** Lines starting with `not ok` (TAP) seen so far. */
  failures: number
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
}

declare module 'claude-code' {
  interface PluginState {
    'bg-watch': {
      jobs: Shaped<Job[]>
      agents: Shaped<AgentRow[]>
    }
  }
}
