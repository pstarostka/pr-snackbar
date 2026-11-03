export type PrSnackbarHost = 'gitlab' | 'azure'
export type PrSnackbarTone = 'success' | 'error' | 'warning' | 'subtle'
export type PrSnackbarChip = { label: string; tone: PrSnackbarTone }
export type PrSnackbarAction = 'fix' | 'resolve' | 'merge'
export type PrSnackbarCheck = { name: string; state: 'passed' | 'failed' | 'running' | 'pending' | 'manual' | 'skipped'; duration?: string }
export type PrSnackbarReviewer = { name: string; state: 'approved' | 'waiting' | 'changes' | 'rejected'; isRequired: boolean }

export type PrSnackbarPr = {
  host: PrSnackbarHost
  id: string
  ref: string
  title: string
  url: string
  source: string | null
  target: string
  chips: PrSnackbarChip[]
  action: PrSnackbarAction | null
  failedCheck: string | null
  // the expandable panel: the host's checks (branch policies, pipeline jobs) and its reviewers
  checksTitle: string
  checks: PrSnackbarCheck[]
  reviewersTitle: string
  reviewers: PrSnackbarReviewer[]
  conflicts: boolean
  // lines added and removed on this branch against origin/<target>; absent when it has none
  diff?: PrSnackbarDiff | null
}

export type PrSnackbarDiff = { added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'pr-snackbar': { pr: PrSnackbarPr | null; expanded: boolean }
  }
}
