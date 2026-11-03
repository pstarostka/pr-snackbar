# pr-snackbar

A Claude Code mod that shows a pull request status bar above the prompt for **GitLab** merge requests and **Azure DevOps** pull requests, like the built-in GitHub one.

For the branch you are on, the bar shows the MR/PR number and title, the pipeline or branch-policy status, approvals or required reviewers, conflicts and drafts. A chevron opens a panel with every job or policy and every reviewer. One button does the next step:

- **Fix with Claude** when the pipeline or build validation fails
- **Resolve with Claude** when the branch conflicts with its target
- **Merge** (GitLab) or **Complete** (Azure DevOps) when it is green and approved; this runs right away

It refreshes every minute and after each Claude turn. GitHub repositories are left to the app's own bar.

## Requirements

The bar reads the host from `git remote get-url origin` and asks the host's own CLI, signed in:

- GitLab: [`glab`](https://gitlab.com/gitlab-org/cli) (`glab auth login`). Any host with "gitlab" in its name counts, so self-managed servers work.
- Azure DevOps: [`az`](https://learn.microsoft.com/cli/azure/) with the `azure-devops` extension (`az extension add --name azure-devops`, then `az login`).

## Install

At the prompt of a terminal session:

```
/plugin install pr-snackbar --marketplace pstarostka/pr-snackbar
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install pr-snackbar --marketplace pstarostka/pr-snackbar
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `pstarostka/pr-snackbar`, then Add plugin.

## License

MIT
