---
name: issue-triage
description: Triage GitHub issues into labels, priority, owner hints, duplicate checks, and next actions.
---

# GitHub Issue Triage

Use this skill when asked to triage GitHub issues, summarize backlog health, or
prepare maintainers for an issue review session.

## Workflow

1. Identify the repository and issue range.
2. Fetch issue title, body, labels, author, comments, linked PRs, and recent
   duplicate candidates through `gh issue view`, `gh issue list`, and
   `gh search issues`.
3. Classify the issue as bug, feature, docs, question, chore, security, or
   support.
4. Estimate priority from impact, reproducibility, affected users, and blocking
   status.
5. Propose labels, owner/team hints, missing information requests, and next
   actions.
6. Keep write actions as proposals unless plugin config explicitly allows them.

## Output

For each issue, produce:

- current state;
- suggested labels;
- priority;
- owner or team hint;
- duplicate or related issue links;
- next action.

End with a compact backlog summary grouped by priority.
