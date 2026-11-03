import { expect, mock, test } from 'claude-code/testing'

const URL = 'https://dev.azure.com/acme/payments/_git/webhooks/pullrequest/4821'

// What `az repos pr list` really returns: `webUrl` is null.
const PR_LIST = [{
  pullRequestId: 4821,
  title: 'Retry queue for webhook delivery, dead-letter table, backoff settings and dashboards',
  isDraft: false,
  mergeStatus: 'succeeded',
  sourceRefName: 'refs/heads/feature/webhook-retry-queue',
  targetRefName: 'refs/heads/main',
  repository: {
    webUrl: null,
    url: 'https://dev.azure.com/acme/0f1e2d3c/_apis/git/repositories/9a8b7c6d',
    name: 'webhooks',
    project: { name: 'payments' },
  },
  reviewers: [{ displayName: 'Marta Wiśniewska', vote: 10, isRequired: true }, { displayName: 'Jonas Keller', vote: 0, isRequired: true }],
}]

const POLICIES = [
  { status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: 'ci-build' } } },
  { status: 'running', configuration: { isBlocking: true, type: { displayName: 'Comment requirements' } } },
]

const BAND = {
  plugin: 'pr-snackbar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 } },
} as const

function engine($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  const opened: string[][] = []
  const clock = mock.clock(on)
  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    if (e.argv[0] === 'open') opened.push([...e.argv])
    const stdout = cmd.startsWith('git remote')
      ? 'https://acme@dev.azure.com/acme/payments/_git/webhooks\n'
      : cmd.startsWith('git rev-parse')
        ? 'feature/webhook-retry-queue\n'
        : cmd.includes('pr list')
          ? JSON.stringify(PR_LIST)
          : cmd.includes('policy list')
            ? JSON.stringify(POLICIES)
            : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, opened }
}

test('the band draws on every surface; the title is cut; branches are shown', async ($, on) => {
  const { clock } = engine($, on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const title = (await ui.find({ type: 'Text', text: /^PR 4821 · / }))?.text ?? ''
    expect(title.endsWith('...')).toBe(true)
    expect((await ui.find({ type: 'Text', text: /→ main/ }))?.text).toBe('feature/webhook-retry... → main · Azure DevOps')
    await ui.unmount()
  }
})

test('the chevron opens the panel with branch policies and required reviewers', async ($, on) => {
  const { clock } = engine($, on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'BRANCH POLICIES' })).toBeUndefined()

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: 'BRANCH POLICIES' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(96))
  expect(await ui.find({ type: 'Text', text: 'ci-build' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'REQUIRED REVIEWERS' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('>MW</text>')
  expect(await ui.find({ type: 'Text', text: 'Jonas Keller' })).toBeDefined()

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: 'BRANCH POLICIES' })).toBeUndefined()
  await ui.unmount()
})

test('the open button opens the PR in the browser on the desktop; the terminal keeps a link', async ($, on) => {
  const { clock, opened } = engine($, on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10)

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desktop.press({ key: 'open' })
  expect(opened).toEqual([['open', URL]])
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await terminal.drawn())).toContain(URL)
  await terminal.unmount()
})

test('the primary action presses on the desktop', async ($, on) => {
  const { clock } = engine($, on)
  const submitted: string[] = []
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { drop: 'test' } })
  PR_LIST[0]!.mergeStatus = 'conflicts'
  try {
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.advance(10)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(JSON.stringify(await ui.drawn())).toContain('Resolve with Claude')
    await ui.press({ key: 'action' })
    expect(submitted[0]).toContain('merge conflicts with main')
    await ui.unmount()
  } finally {
    PR_LIST[0]!.mergeStatus = 'succeeded'
  }
})
