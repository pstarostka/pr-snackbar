import type {
  PrSnackbarAction,
  PrSnackbarCheck,
  PrSnackbarReviewer,
  PrSnackbarChip,
  PrSnackbarHost,
  PrSnackbarPr,
} from '../types'

// Long titles crowd the chips and buttons off the row.
export function shortTitle(title: string, max = 48): string {
  return title.length <= max ? title : `${title.slice(0, max - 3).trimEnd()}...`
}

// Picks the host from `git remote get-url origin`. GitHub is left to the
// app's built-in bar.
// Any hostname containing "gitlab" counts as GitLab. A self-managed instance
// named otherwise can be listed in the plugin's `gitlabHosts` setting.

// The `gitlabHosts` setting: "a.example.com, b.example.com". A pasted URL
// ("https://git.example.com:8443/group") counts as its hostname.
export function parseHostList(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value.split(',')
    .map(h => h.trim().toLowerCase().replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/[/:].*$/, ''))
    .filter(Boolean)
}

export function detectHost(remote: string, extraGitlabHosts: readonly string[] = []): PrSnackbarHost | null {
  const url = remote.trim()
  const host = (url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i) ??
    url.match(/^[^@/]+@([^:]+):/))?.[1]?.toLowerCase()
  if (!host) return null
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure'
  if (host.includes('gitlab') || extraGitlabHosts.includes(host)) return 'gitlab'
  return null
}

type GitlabMr = {
  iid: number
  title: string
  web_url: string
  state: string
  draft?: boolean
  has_conflicts?: boolean
  detailed_merge_status?: string
  source_branch?: string
  target_branch: string
  head_pipeline?: { id: number; status: string } | null
  reviewers?: { name: string; username?: string }[]
}

type GitlabApprovals = {
  approvals_required?: number
  approvals_left?: number
  approved_by?: { user?: { name?: string; username?: string } }[]
}

type GitlabJob = { name: string; status: string; duration?: number | null }

const GITLAB_JOB_STATE: Record<string, PrSnackbarCheck['state']> = {
  success: 'passed', failed: 'failed', running: 'running', canceled: 'skipped', skipped: 'skipped', manual: 'manual',
}

// A merged, completed, abandoned or closed MR/PR stays on the bar, like the app's GitHub bar: one chip saying how it
// ended, nothing to press. The panel keeps its checks and reviewers.
export function ended(pr: PrSnackbarPr, chip: PrSnackbarChip): PrSnackbarPr {
  return { ...pr, chips: [chip], action: null, failedCheck: null, conflicts: false }
}

const RUNNING = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled']

export function parseGitlab(
  mr: GitlabMr,
  approvals: GitlabApprovals | null,
  failedJob: string | null,
  jobs: GitlabJob[] = [],
): PrSnackbarPr {
  const chips: PrSnackbarChip[] = []
  const pipeline = mr.head_pipeline?.status
  const failed = pipeline === 'failed'
  if (mr.draft) chips.push({ label: 'Draft', tone: 'subtle' })
  if (pipeline && RUNNING.includes(pipeline)) chips.push({ label: 'Pipeline running', tone: 'warning' })
  else if (failed) chips.push({ label: failedJob ? `Pipeline failed · ${failedJob}` : 'Pipeline failed', tone: 'error' })
  else if (pipeline === 'manual') {
    // The pipeline stopped at a manual job someone has to start.
    const job = jobs.find(j => j.status === 'manual')?.name
    chips.push({ label: job ? `Pipeline waiting · ${job}` : 'Pipeline waiting', tone: 'warning' })
  } else if (pipeline === 'success') chips.push({ label: 'Pipeline passed', tone: 'success' })
  // canceled, skipped, and any status GitLab adds later
  else if (pipeline) chips.push({ label: `Pipeline ${pipeline}`, tone: 'subtle' })
  if (mr.has_conflicts) chips.push({ label: `Conflicts with ${mr.target_branch}`, tone: 'error' })

  if (approvals) {
    const required = approvals.approvals_required ?? 0
    const left = approvals.approvals_left ?? 0
    const given = approvals.approved_by?.length ?? 0
    if (given > 0 && left === 0) chips.push({ label: 'Approved', tone: 'success' })
    else if (required > 0) chips.push({ label: `${required - left} of ${required} approvals`, tone: 'subtle' })
  }

  const action: PrSnackbarAction | null = mr.has_conflicts
    ? 'resolve'
    : failed
      ? 'fix'
      : mr.detailed_merge_status === 'mergeable'
        ? 'merge'
        : null

  const pr: PrSnackbarPr = {
    host: 'gitlab',
    id: String(mr.iid),
    ref: `MR !${mr.iid}`,
    title: mr.title,
    url: mr.web_url,
    source: mr.source_branch ?? null,
    target: mr.target_branch,
    chips,
    action,
    failedCheck: failedJob,
    checksTitle: mr.head_pipeline ? `Pipeline #${mr.head_pipeline.id}` : 'Pipeline',
    checks: jobs.map(job => ({
      name: job.name,
      state: GITLAB_JOB_STATE[job.status] ?? 'pending',
      ...(job.duration ? { duration: formatDuration(job.duration) } : {}),
    })),
    reviewersTitle: 'Approvals',
    reviewers: gitlabReviewers(mr, approvals),
    conflicts: !!mr.has_conflicts,
  }
  if (mr.state === 'merged') return ended(pr, { label: 'Merged', tone: 'success' })
  if (mr.state !== 'opened') return ended(pr, { label: 'Closed', tone: 'subtle' })
  return pr
}

function gitlabReviewers(mr: GitlabMr, approvals: GitlabApprovals | null): PrSnackbarReviewer[] {
  const approvedBy = (approvals?.approved_by ?? []).map(a => a.user?.username ?? a.user?.name).filter(Boolean)
  const assigned = mr.reviewers ?? []
  const reviewers: PrSnackbarReviewer[] = assigned.map(r => ({
    name: r.name,
    state: approvedBy.includes(r.username ?? r.name) ? 'approved' : 'waiting',
    isRequired: false,
  }))
  // approvers who were not asked for a review still count
  for (const a of approvals?.approved_by ?? []) {
    const name = a.user?.name ?? a.user?.username
    if (name && !assigned.some(r => (r.username ?? r.name) === (a.user?.username ?? a.user?.name)))
      reviewers.push({ name, state: 'approved', isRequired: false })
  }
  return reviewers
}

type AzurePr = {
  pullRequestId: number
  title: string
  status?: string
  isDraft?: boolean
  mergeStatus?: string
  sourceRefName?: string
  targetRefName: string
  // `az repos pr list` fills `url` (the REST address) and the names, but leaves `webUrl` null
  repository: { webUrl?: string | null; url: string; name: string; project: { name: string } }
  reviewers?: { vote: number; isRequired?: boolean; displayName?: string; isContainer?: boolean }[]
}

type AzurePolicy = {
  status: string
  startedDate?: string
  completedDate?: string
  // a build policy names its pipeline here; its own `displayName` is usually null
  context?: { buildDefinitionName?: string }
  configuration: {
    isBlocking?: boolean
    type: { displayName: string }
    settings?: { displayName?: string | null }
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// The browser address of the repository: `webUrl` when the API sent it, else built from the REST address
// (`<org>/<projectId>/_apis/git/repositories/<repoId>`) and the names.
export function azureRepoWebUrl(repository: AzurePr['repository']): string {
  if (repository.webUrl) return repository.webUrl
  const projectBase = repository.url.slice(0, repository.url.indexOf('/_apis/'))
  const org = projectBase.slice(0, projectBase.lastIndexOf('/'))
  return `${org}/${encodeURIComponent(repository.project.name)}/_git/${encodeURIComponent(repository.name)}`
}

// `az repos pr list --status all` lists the newest first: the active PR wins, else the newest ended one.
export function pickAzurePr(list: AzurePr[] | null | undefined): AzurePr | null {
  return list?.find(pr => pr.status === 'active') ?? list?.[0] ?? null
}

// Reviewer policies are shown by the reviewers chip, not the policies chip.
const REVIEW_POLICIES = ['Minimum number of reviewers', 'Required reviewers']

export function parseAzure(pr: AzurePr, policies: AzurePolicy[]): PrSnackbarPr {
  const chips: PrSnackbarChip[] = []
  const target = pr.targetRefName.replace(/^refs\/heads\//, '')
  if (pr.isDraft) chips.push({ label: 'Draft', tone: 'subtle' })

  // Optional policies (an optional build validation, say) are shown and reported too; only the blocking ones gate
  // Complete.
  const checked = policies.filter(
    p => p.status !== 'notApplicable' && !REVIEW_POLICIES.includes(p.configuration.type.displayName),
  )
  const gates = checked.filter(p => p.configuration.isBlocking !== false)
  const name = (p: AzurePolicy) =>
    p.configuration.settings?.displayName || p.context?.buildDefinitionName || p.configuration.type.displayName
  const rejected = checked.find(p => p.status === 'rejected' || p.status === 'broken')
  const done = gates.filter(p => p.status === 'approved').length
  const checkedDone = checked.filter(p => p.status === 'approved').length
  if (rejected) chips.push({ label: `Policies failed · ${name(rejected)}`, tone: 'error' })
  else if (checked.length && checkedDone < checked.length) chips.push({ label: `Policies running · ${checkedDone}/${checked.length}`, tone: 'warning' })
  else if (checked.length) chips.push({ label: 'Policies passed', tone: 'success' })

  const conflicts = pr.mergeStatus === 'conflicts'
  if (conflicts) chips.push({ label: `Conflicts with ${target}`, tone: 'error' })

  const reviewers = pr.reviewers ?? []
  const required = reviewers.filter(r => r.isRequired)
  const approvedRequired = required.filter(r => r.vote >= 5).length
  let approved = false
  if (reviewers.some(r => r.vote === -10)) chips.push({ label: 'Rejected', tone: 'error' })
  else if (reviewers.some(r => r.vote === -5)) chips.push({ label: 'Waiting for author', tone: 'warning' })
  else if (required.length && approvedRequired < required.length)
    chips.push({ label: `${approvedRequired} of ${required.length} required reviewers`, tone: 'subtle' })
  else if (reviewers.some(r => r.vote >= 5)) {
    chips.push({ label: 'Approved', tone: 'success' })
    approved = true
  } else chips.push({ label: 'No approvals yet', tone: 'subtle' })

  const buildFailed = rejected?.configuration.type.displayName === 'Build'
  const action: PrSnackbarAction | null = conflicts
    ? 'resolve'
    : buildFailed
      ? 'fix'
      : approved && !rejected && done === gates.length && !pr.isDraft
        ? 'merge'
        : null

  const result: PrSnackbarPr = {
    host: 'azure',
    id: String(pr.pullRequestId),
    ref: `PR ${pr.pullRequestId}`,
    title: pr.title,
    url: `${azureRepoWebUrl(pr.repository)}/pullrequest/${pr.pullRequestId}`,
    source: pr.sourceRefName?.replace(/^refs\/heads\//, '') ?? null,
    target,
    chips,
    action,
    failedCheck: rejected ? name(rejected) : null,
    checksTitle: 'Branch policies',
    checks: checked.map(p => {
      const started = p.startedDate ? Date.parse(p.startedDate) : NaN
      const finished = p.completedDate ? Date.parse(p.completedDate) : NaN
      const seconds = (finished - started) / 1000
      return {
        name: name(p),
        state: AZURE_POLICY_STATE[p.status] ?? 'pending',
        ...(seconds > 0 ? { duration: formatDuration(seconds) } : {}),
      }
    }),
    reviewersTitle: required.length ? 'Required reviewers' : 'Reviewers',
    reviewers: reviewers.map(r => ({
      name: r.displayName ?? 'Reviewer',
      state: r.vote >= 5 ? 'approved' : r.vote === -10 ? 'rejected' : r.vote === -5 ? 'changes' : 'waiting',
      isRequired: !!r.isRequired,
    })),
    conflicts,
  }
  if (pr.status === 'completed') return ended(result, { label: 'Completed', tone: 'success' })
  if (pr.status === 'abandoned') return ended(result, { label: 'Abandoned', tone: 'subtle' })
  return result
}

const AZURE_POLICY_STATE: Record<string, PrSnackbarCheck['state']> = {
  approved: 'passed', rejected: 'failed', broken: 'failed', running: 'running', queued: 'pending',
}
