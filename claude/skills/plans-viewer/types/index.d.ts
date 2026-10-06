// `dir` is the folder as configured in `planDirs`; `path` is the resolved file path and the plan's identity.
export type Plan = { path: string; dir: string; name: string; mtimeMs: number; text: string }

declare module 'claude-code' {
  interface PluginState {
    'plans-viewer': { plans: Plan[]; selected: string | null }
  }
}
