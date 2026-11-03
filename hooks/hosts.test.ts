import { expect, test } from 'claude-code/testing'

import { detectHost, formatDuration, parseAzure, parseGitlab, parseHostList, shortTitle } from './hosts'

test('picks the host from the remote', () => {
  expect(detectHost('git@gitlab.com:acme/api.git')).toBe('gitlab')
  expect(detectHost('https://gitlab.acme.dev/acme/api.git')).toBe('gitlab')
  expect(detectHost('git@ssh.dev.azure.com:v3/acme/payments/webhooks')).toBe('azure')
  expect(detectHost('https://acme@dev.azure.com/acme/payments/_git/webhooks')).toBe('azure')
  expect(detectHost('https://acme.visualstudio.com/payments/_git/webhooks')).toBe('azure')
  expect(detectHost('git@github.com:acme/api.git')).toBe(null)
  expect(detectHost('')).toBe(null)
  expect(detectHost('git@git.example.net:acme/api.git')).toBe(null)
  expect(detectHost('git@git.example.net:acme/api.git', parseHostList('other.test, Git.Example.net'))).toBe('gitlab')
  expect(parseHostList('')).toEqual([])
  expect(parseHostList(undefined)).toEqual([])
})

const mr = {
  iid: 142,
  title: 'Add retry queue',
  web_url: 'https://gitlab.com/acme/api/-/merge_requests/142',
  state: 'opened',
  target_branch: 'main',
  detailed_merge_status: 'ci_must_pass',
  head_pipeline: { id: 7, status: 'failed' },
}

test('a failed GitLab pipeline offers a fix', () => {
  const pr = parseGitlab(mr, { approvals_required: 2, approvals_left: 1, approved_by: [{}] }, 'test:unit')
  expect(pr?.ref).toBe('MR !142')
  expect(pr?.action).toBe('fix')
  expect(pr?.chips).toEqual([
    { label: 'Pipeline failed · test:unit', tone: 'error' },
    { label: '1 of 2 approvals', tone: 'subtle' },
  ])
})

test('a green, approved MR offers merge; conflicts win over everything', () => {
  const ready = { ...mr, detailed_merge_status: 'mergeable', head_pipeline: { id: 7, status: 'success' } }
  expect(parseGitlab(ready, { approvals_left: 0, approved_by: [{}] }, null)?.action).toBe('merge')
  expect(parseGitlab({ ...mr, has_conflicts: true }, null, null)?.action).toBe('resolve')
  expect(parseGitlab({ ...mr, state: 'merged' }, null, null)).toBe(null)
})

const azure = {
  pullRequestId: 4821,
  title: 'Add retry queue',
  targetRefName: 'refs/heads/main',
  mergeStatus: 'succeeded',
  repository: {
    webUrl: 'https://dev.azure.com/acme/payments/_git/webhooks',
    url: 'https://dev.azure.com/acme/0f1e/_apis/git/repositories/9a8b',
    name: 'webhooks',
    project: { name: 'payments' },
  },
  reviewers: [{ vote: 10, isRequired: true }, { vote: 0, isRequired: true }],
}
const build = (status: string) => ({ status, configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: 'CI' } } })
const reviewersPolicy = { status: 'queued', configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } } }

test('Azure DevOps: failed build validation offers a fix, reviewer policy is not a check', () => {
  const pr = parseAzure(azure, [build('rejected'), reviewersPolicy])
  expect(pr.url).toBe('https://dev.azure.com/acme/payments/_git/webhooks/pullrequest/4821')
  expect(pr.action).toBe('fix')
  expect(pr.chips).toEqual([
    { label: 'Policies failed · CI', tone: 'error' },
    { label: '1 of 2 required reviewers', tone: 'subtle' },
  ])
})

test('Azure DevOps: approved and green offers Complete; conflicts offer a rebase', () => {
  const approved = { ...azure, reviewers: [{ vote: 10, isRequired: true }] }
  expect(parseAzure(approved, [build('approved'), reviewersPolicy]).action).toBe('merge')
  expect(parseAzure({ ...approved, mergeStatus: 'conflicts' }, [build('approved')]).action).toBe('resolve')
  expect(parseAzure({ ...approved, isDraft: true }, [build('approved')]).action).toBe(null)
})

test('Azure DevOps: az leaves webUrl null, the link is built from the REST address and the names', () => {
  const fromList = {
    ...azure,
    repository: {
      webUrl: null,
      url: 'https://dev.azure.com/acme/0f1e2d3c-4b5a/_apis/git/repositories/9a8b7c6d-5e4f',
      name: 'Web Hooks',
      project: { name: 'payments' },
    },
  }
  expect(parseAzure(fromList, []).url).toBe('https://dev.azure.com/acme/payments/_git/Web%20Hooks/pullrequest/4821')
})

test('a long title is cut with "..."; a short one is left alone', () => {
  expect(shortTitle('Add retry queue')).toBe('Add retry queue')
  const cut = shortTitle('Retry queue for webhook delivery, dead-letter table, backoff settings and dashboards')
  expect(cut.length).toBeLessThanOrEqual(48)
  expect(cut.endsWith('...')).toBe(true)
})

test('GitLab panel: every pipeline job with its state; reviewers approved or waiting', () => {
  const withReviewers = { ...mr, reviewers: [{ name: 'Marta W', username: 'marta' }, { name: 'Jonas K', username: 'jonas' }] }
  const pr = parseGitlab(
    withReviewers,
    { approvals_required: 2, approvals_left: 1, approved_by: [{ user: { name: 'Marta W', username: 'marta' } }] },
    'test:unit',
    [{ name: 'build', status: 'success' }, { name: 'test:unit', status: 'failed' }, { name: 'deploy', status: 'manual' }],
  )
  expect(pr?.checksTitle).toBe('Pipeline #7')
  expect(pr?.checks).toEqual([
    { name: 'build', state: 'passed' },
    { name: 'test:unit', state: 'failed' },
    { name: 'deploy', state: 'skipped' },
  ])
  expect(pr?.reviewers).toEqual([
    { name: 'Marta W', state: 'approved', isRequired: false },
    { name: 'Jonas K', state: 'waiting', isRequired: false },
  ])
})

test('Azure DevOps: an optional build validation is shown under its pipeline name, with its time', () => {
  const optionalBuild = {
    status: 'approved',
    startedDate: '2026-11-02T09:15:01Z',
    completedDate: '2026-11-02T09:17:28Z',
    context: { buildDefinitionName: 'Build and test solution' },
    configuration: { isBlocking: false, type: { displayName: 'Build' }, settings: { displayName: null } },
  }
  const pr = parseAzure(azure, [optionalBuild])
  expect(pr.checks).toEqual([{ name: 'Build and test solution', state: 'passed', duration: '2m 27s' }])
  expect(pr.chips[0]).toEqual({ label: 'Policies passed', tone: 'success' })
  expect(formatDuration(18)).toBe('18s')
})
