import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register } from 'claude-code'

import type { PrSnackbarPr } from '../types'
import { detectHost, parseAzure, parseGitlab, parseHostList, pickAzurePr, shortTitle } from './hosts'

const prAtom = atom({ plugin: 'pr-snackbar', key: 'pr' } as const, null)
const expandedAtom = atom({ plugin: 'pr-snackbar', key: 'expanded' } as const, false)

const POLL_MS = 60_000

// The host badge colours of the design mockup.
const BADGE = { gitlab: { label: 'GL', color: '#9A3412' }, azure: { label: 'AZ', color: '#1D4ED8' } } as const
const MUTED = '#71717A'
// Mid-tone colours over a translucent tint of themselves: the mockup's light pills on a light theme, dark ones on a
// dark theme (a mod can't read the app's theme).
const TONE = { success: '#16A34A', error: '#DC2626', warning: '#D97706', subtle: '#71717A' } as const
const CHECK = {
  passed: { tone: TONE.success, label: '' },
  failed: { tone: TONE.error, label: 'failed' },
  running: { tone: TONE.warning, label: 'running' },
  pending: { tone: TONE.subtle, label: 'queued' },
  manual: { tone: TONE.warning, label: 'manual' },
  skipped: { tone: TONE.subtle, label: 'skipped' },
} as const
const REVIEW = {
  approved: { color: TONE.success, label: 'Approved' },
  waiting: { color: TONE.subtle, label: 'Waiting' },
  changes: { color: TONE.warning, label: 'Waiting for author' },
  rejected: { color: TONE.error, label: 'Rejected' },
} as const
const initials = (name: string) =>
  name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?'

// Rounded, coloured shapes exist only as Svg on the desktop (no radius on Box), so the badge, the chips and the
// avatars are drawn as small SVGs, widths estimated from the label length. Buttons stay native: a desktop draws its
// own button even for `plain`, so nothing can be laid over an Svg to make it pressable.
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

const badgeSvg = (label: string, color: string) => ({
  w: 32, h: 32,
  source: svg(32, 32, `<rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="20.5" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#FFFFFF">${esc(label)}</text>`),
})

const pillSvg = (label: string, color: string) => {
  const w = Math.ceil(label.length * 6.7) + 32
  return {
    w, h: 24,
    source: svg(w, 24, `<rect width="${w}" height="24" rx="12" fill="${color}" fill-opacity="0.16"/><circle cx="13" cy="12" r="3" fill="${color}"/><text x="22" y="16" font-family="${FONT}" font-size="12" font-weight="500" fill="${color}">${esc(label)}</text>`),
  }
}

const CHECK_ICON: Record<keyof typeof CHECK, string> = {
  passed: '<path d="M5.2 8.2l1.9 1.9 3.7-3.9" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  failed: '<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" fill="none" stroke-width="1.5" stroke-linecap="round"/>',
  running: '<path d="M8 3.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke-width="1.5" stroke-linecap="round"/>',
  pending: '',
  // a play mark: the job waits for someone to start it
  manual: '<path d="M6.6 5.4v5.2l4-2.6z" fill="none" stroke-width="1.5" stroke-linejoin="round"/>',
  skipped: '<path d="M5.5 8h5" fill="none" stroke-width="1.5" stroke-linecap="round"/>',
}
const checkSvg = (state: keyof typeof CHECK) => {
  const color = CHECK[state].tone
  const ring = state === 'pending'
    ? `<circle cx="8" cy="8" r="6.25" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="2 2"/>`
    : `<circle cx="8" cy="8" r="6.25" fill="none" stroke="${color}" stroke-width="1.5"/>`
  return svg(16, 16, `${ring}<g stroke="${color}">${CHECK_ICON[state]}</g>`)
}


const avatarSvg = (initials: string) =>
  svg(24, 24, `<circle cx="12" cy="12" r="12" fill="${TONE.subtle}" fill-opacity="0.22"/><text x="12" y="16" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="600" fill="${TONE.subtle}">${esc(initials)}</text>`)

// macOS, then freedesktop, then Windows (rundll32 exits 0 on success, unlike explorer)
const OPENERS = [['open'], ['xdg-open'], ['rundll32', 'url.dll,FileProtocolHandler']]

async function openInBrowser($: EngineInterface, url: string) {
  for (const opener of OPENERS) {
    const r = await $.process.run([...opener, url], { timeoutMs: 10_000 }).catch(() => null)
    if (r?.exitCode === 0) return
  }
  $.ui.toast(`Could not open ${url}`)
}

const HOST_NAME = { gitlab: 'GitLab', azure: 'Azure DevOps' } as const

// Windows finds a `.cmd` shim (the Azure CLI is az.cmd) only through cmd.exe, and argv runs without a shell: a command
// that cannot start is tried once more as `cmd /c <argv>`.
// ponytail: cmd /c reads & | ^ % in arguments; fine for branch names and ids, quote them if that ever bites.
async function run($: EngineInterface, argv: string[], init?: ProcessRunInit): Promise<ProcessRunResult> {
  try {
    return await $.process.run(argv, init)
  } catch (error) {
    return await $.process.run(['cmd', '/c', ...argv], init).catch(() => {
      throw error
    })
  }
}

async function json($: EngineInterface, argv: string[]): Promise<any> {
  try {
    const r = await run($, argv, { timeoutMs: 20_000 })
    return r.exitCode === 0 ? JSON.parse(r.stdout) : null
  } catch {
    return null
  }
}

// Set from the `gitlabHosts` setting each time the module loads.
let gitlabHosts: string[] = []

async function currentBranch($: EngineInterface): Promise<string | null> {
  const r = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
  return r?.exitCode === 0 ? r.stdout.trim() || null : null
}

async function fetchPr($: EngineInterface): Promise<PrSnackbarPr | null> {
  const remote = await run($, ['git', 'remote', 'get-url', 'origin']).catch(() => null)
  if (!remote || remote.exitCode !== 0) return null
  const host = detectHost(remote.stdout, gitlabHosts)

  if (host === 'gitlab') {
    // `glab mr view` finds only an open MR; a merged or closed one is found by its source branch.
    let mr = await json($, ['glab', 'mr', 'view', '-F', 'json'])
    if (!mr) {
      const branch = await currentBranch($)
      if (!branch) return null
      const listed = (await json($, ['glab', 'mr', 'list', '--source-branch', branch, '--all', '-F', 'json']))?.[0]
      // The list leaves out head_pipeline; viewing by number returns the full MR in any state.
      mr = listed && ((await json($, ['glab', 'mr', 'view', String(listed.iid), '-F', 'json'])) ?? listed)
    }
    if (!mr) return null
    const approvals = await json($, ['glab', 'api', `projects/:id/merge_requests/${mr.iid}/approvals`])
    const jobs = mr.head_pipeline
      ? ((await json($, ['glab', 'api', `projects/:id/pipelines/${mr.head_pipeline.id}/jobs`])) ?? [])
      : []
    const failedJob = jobs.find((job: { status: string }) => job.status === 'failed')?.name ?? null
    return parseGitlab(mr, approvals, failedJob, jobs)
  }

  if (host === 'azure') {
    const branch = await currentBranch($)
    if (!branch) return null
    // `--status all`: a completed or abandoned PR stays on the bar
    const list = await json($, [
      'az', 'repos', 'pr', 'list', '--source-branch', branch,
      '--status', 'all', '--detect', 'true', '-o', 'json',
    ])
    const pr = pickAzurePr(list)
    if (!pr) return null
    const policies = await json($, [
      'az', 'repos', 'pr', 'policy', 'list', '--id', String(pr.pullRequestId), '--detect', 'true', '-o', 'json',
    ])
    return parseAzure(pr, policies ?? [])
  }

  return null
}

let isBusy = false
async function refresh($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    const pr = await fetchPr($)
    await update($, prAtom, () => pr)
  } finally {
    isBusy = false
  }
}

function promptFor(pr: PrSnackbarPr): string {
  if (pr.action === 'resolve') {
    return `${pr.ref} (${pr.url}) has merge conflicts with ${pr.target}. Rebase this branch onto origin/${pr.target}, resolve the conflicts, run the tests and push.`
  }
  const where = pr.host === 'gitlab' ? 'pipeline' : 'build validation'
  const how = pr.host === 'gitlab' ? 'glab ci view / glab ci trace' : 'az pipelines runs list / az pipelines runs show'
  const check = pr.failedCheck ? ` (${pr.failedCheck})` : ''
  return `The ${where}${check} for ${pr.ref} (${pr.url}) failed. Read the failing log with ${how}, find the cause, fix it and push.`
}

async function merge($: EngineInterface, pr: PrSnackbarPr) {
  const argv = pr.host === 'gitlab'
    ? ['glab', 'mr', 'merge', pr.id, '--yes']
    : ['az', 'repos', 'pr', 'update', '--id', pr.id, '--status', 'completed', '--detect', 'true', '-o', 'none']
  const r = await run($, argv, { timeoutMs: 60_000 }).catch(() => null)
  $.ui.toast(r?.exitCode === 0
    ? `${pr.ref} ${pr.host === 'gitlab' ? 'merged' : 'completed'}`
    : `Could not ${pr.host === 'gitlab' ? 'merge' : 'complete'} ${pr.ref}: ${(r?.stderr ?? 'command failed').trim().slice(0, 200)}`)
  await refresh($)
}

export const register: Register = (on, options) => {
  gitlabHosts = parseHostList(options.gitlabHosts)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.clock.after(1, () => void refresh($))
    $.clock.every(POLL_MS, () => void refresh($))
    return started
  })

  // Claude often pushes during a turn: check right after it.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    $.clock.after(1, () => void refresh($))
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const pr = await read($, prAtom)
    if (!pr) return next(e)
    const expanded = await read($, expandedAtom)

    const { Box, Text, Button, Link, Svg } = $.ui.resolve(e)
    const actionLabel = pr.action === 'fix'
      ? 'Fix with Claude'
      : pr.action === 'resolve'
        ? 'Resolve with Claude'
        : pr.host === 'gitlab' ? 'Merge' : 'Complete'
    const badge = BADGE[pr.host]
    const branches = pr.source ? `${shortTitle(pr.source, 24)} → ${pr.target}` : `→ ${pr.target}`
    const openLabel = `Open in ${HOST_NAME[pr.host]}`
    const isDesktop = e.surface === 'desktop'
    const runAction = () =>
      pr.action === 'merge'
        ? void merge($, pr)
        : void $.prompt.submit({ text: promptFor(pr), asUser: true })

    const heading = (text: string) => (
      <Text size="caption" weight="semibold" color={MUTED}>{text.toUpperCase()}</Text>
    )

    // Laid out as the design mockup: a bordered card; the details panel opens above the row.
    return (
      <Box flexDirection="column" rowGap="sm" paddingX="xs">
        {expanded && (
          <Box flexDirection="row" columnGap="lg" paddingX="xs" paddingY="xs">
            <Box flexDirection="column" rowGap="xs" flexGrow={1} flexShrink={1} minWidth={10}>
              {heading(pr.checksTitle)}
              {pr.checks.length === 0 && <Text dimColor size="caption">Nothing to check</Text>}
              {pr.checks.map(check => (
                <Box key={`check-${check.name}`} flexDirection="row" columnGap="sm" alignItems="center">
                  {isDesktop
                    ? <Svg source={checkSvg(check.state)} alt={check.state} width={16} height={16} />
                    : <Text color={CHECK[check.state].tone}>{check.state === 'passed' ? '✓' : check.state === 'failed' ? '✕' : '○'}</Text>}
                  <Box flexGrow={1} flexShrink={1} minWidth={5}>
                    <Text mono size="caption" wrap="truncate-end">{check.name}</Text>
                  </Box>
                  <Text size="caption" color={check.state === 'passed' ? undefined : CHECK[check.state].tone} dimColor={check.state === 'passed'}>
                    {check.state === 'failed' || !check.duration ? CHECK[check.state].label : check.duration}
                  </Text>
                </Box>
              ))}
            </Box>
            <Box flexDirection="column" rowGap="xs" flexGrow={1} flexShrink={1} minWidth={10}>
              {heading(pr.reviewersTitle)}
              {pr.reviewers.length === 0 && <Text dimColor size="caption">No reviewers</Text>}
              {pr.reviewers.map(reviewer => (
                <Box key={`reviewer-${reviewer.name}`} flexDirection="row" columnGap="xs" alignItems="center">
                  {isDesktop
                    ? <Svg source={avatarSvg(initials(reviewer.name))} alt={reviewer.name} width={24} height={24} />
                    : <Text weight="semibold" dimColor>{initials(reviewer.name)}</Text>}
                  <Box flexGrow={1} flexShrink={1} minWidth={5}>
                    <Text size="caption" wrap="truncate-end">{reviewer.name}</Text>
                  </Box>
                  <Text size="caption" color={REVIEW[reviewer.state].color}>{REVIEW[reviewer.state].label}</Text>
                </Box>
              ))}
              {pr.conflicts && (
                <Text size="caption" color="#B91C1C">✕ Conflicts with {pr.target}</Text>
              )}
            </Box>
          </Box>
        )}
        {expanded && (
          // monospaced dashes, one per cell the band has and a margin short, so the line is never cut (a cut adds an
          // ellipsis) and keeps one thickness on every surface (an Svg is scaled to fit)
          <Text mono dimColor>{'─'.repeat(Math.max(10, (e.props.bodyColumns ?? 80) - 4))}</Text>
        )}
        <Box flexDirection="row" alignItems="center" columnGap="sm">
          {isDesktop
            ? <Svg source={badgeSvg(badge.label, badge.color).source} alt={HOST_NAME[pr.host]} width={32} height={32} />
            : (
              <Box backgroundColor={badge.color} paddingX="sm" flexShrink={0}>
                <Text color="#FFFFFF" weight="semibold">{badge.label}</Text>
              </Box>
            )}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={10}>
            <Text size="footnote" weight="semibold" wrap="truncate-end">{pr.ref} · {shortTitle(pr.title, 40)}</Text>
            <Text mono size="caption" dimColor wrap="truncate-end">{branches} · {HOST_NAME[pr.host]}</Text>
          </Box>
          <Box flexDirection="row" columnGap="xs" alignItems="center" flexShrink={0}>
            {pr.chips.map(chip => {
              const color = TONE[chip.tone]
              if (!isDesktop) return <Text key={chip.label} color={color}>● {chip.label}</Text>
              const pill = pillSvg(chip.label, color)
              return <Svg key={chip.label} source={pill.source} alt={chip.label} width={pill.w} height={pill.h} />
            })}
          </Box>
          <Button
            key="toggle"
            plain
            dimColor
            label={expanded ? '∧' : '∨'}
            onPress={() => void update($, expandedAtom, isOpen => !isOpen)}
          />
          {pr.action && <Button key="action" variant="primary" label={actionLabel} onPress={runAction} />}
          {isDesktop
            ? <Button key="open" variant="secondary" label="↗" onPress={() => void openInBrowser($, pr.url)} />
            : <Link href={pr.url} label="↗" />}
        </Box>
      </Box>
    )
  })
}
