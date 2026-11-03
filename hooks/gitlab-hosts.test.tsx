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
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const ran: string[] = []
  const clock = mock.clock(on)
  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    ran.push(cmd)
    const stdout = cmd.startsWith('git remote')
      ? 'git@git.example.net:acme/api.git\n'
      : cmd.startsWith('glab mr view')
        ? JSON.stringify(MR)
        : cmd.includes('approvals')
          ? JSON.stringify({ approvals_required: 1, approvals_left: 1, approved_by: [] })
          : ''
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
