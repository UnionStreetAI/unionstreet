---
name: github-cli
description: Use GitHub through the official gh CLI and local git. Use for pull requests, issues, releases, workflow checks, repository metadata, and safe GitHub automation without relying on GitHub MCP.
---

# GitHub CLI

Prefer `gh` plus local `git` for GitHub workflows.

## Checks

```sh
gh auth status
gh repo view --json nameWithOwner,url,defaultBranchRef
git status --short
```

## Common Commands

```sh
gh pr view --json number,title,state,author,headRefName,baseRefName,url
gh pr diff --patch
gh pr checks
gh issue list --limit 20 --json number,title,state,labels,assignees
gh release list --limit 10
```

## Rules

- Read first; propose writes unless write actions were explicitly allowed.
- Use local `git diff` for working-tree changes.
- Use `gh` for GitHub server state.
- Never use GitHub MCP for this plugin path.
