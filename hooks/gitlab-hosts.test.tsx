import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'pr-snackbar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } },
} as const

const MR = {
  iid: 142,
  title: 'Add retry queue',
  web_url: 'https://git.example.net/acme/api/-/merge_requests/142',
  state: 'opened',
  source_branch: 'feature/retry-queue',
  target_branch: 'main',
  detailed_merge_status: 'ci_must_pass',
  head_pipeline: null,
}

// A self-managed GitLab whose hostname doesn't contain "gitlab".
// merged: the MR was merged, so `glab mr view` alone finds nothing and the list leaves out head_pipeline.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], merged = false) {
  const ran: string[] = []
  const clock = mock.clock(on)
  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    ran.push(cmd)
    const full = merged ? { ...MR, state: 'merged', head_pipeline: { id: 7, status: 'success' } } : MR
    const stdout = cmd.startsWith('git remote')
      ? 'git@git.example.net:acme/api.git\n'
      : cmd.startsWith('git rev-parse')
        ? 'feature/retry-queue\n'
        : cmd.startsWith('glab mr list')
          ? JSON.stringify([{ ...full, head_pipeline: undefined }])
          : cmd === 'glab mr view 142 -F json' || cmd === 'glab mr view -F json'
            ? merged && cmd === 'glab mr view -F json' ? null : JSON.stringify(full)
            : cmd.includes('approvals')
              ? JSON.stringify({ approvals_required: 1, approvals_left: 1, approved_by: [] })
              : cmd.includes('pipelines/7/jobs')
                ? JSON.stringify([{ name: 'unit', status: 'success' }])
                : ''
    if (stdout === null) return { value: { exitCode: 1, stdout: '', stderr: 'no open merge request', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, ran }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a host listed in Extra GitLab hosts shows the bar`, { options: { gitlabHosts: 'other.test, https://Git.Example.net' } }, async ($, on) => {
    const { clock } = engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await clock.advance(10)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^MR !142 · / })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: without the setting that host is left alone`, async ($, on) => {
    const { clock, ran } = engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await clock.advance(10)
    expect(ran.some(cmd => cmd.startsWith('git remote'))).toBe(true)
    expect(ran.some(cmd => cmd.startsWith('glab'))).toBe(false)
  })
}

test('a merged MR stays on the band, with its pipeline jobs', { options: { gitlabHosts: 'git.example.net' } }, async ($, on) => {
  const { clock, ran } = engine(on, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^MR !142 · / })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('>Merged</text>')
  expect(ran).toContain('glab mr list --source-branch feature/retry-queue --all -F json')
  expect(ran).toContain('glab api projects/:id/pipelines/7/jobs')
  await ui.unmount()
})
