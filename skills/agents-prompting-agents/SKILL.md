---
name: agents-prompting-agents
description: Design prompts where one agent asks other Union Street agents to work, delegate, report, or synthesize. Use when writing head-agent prompts, director prompts, or live org tests.
license: MIT
compatibility: Requires Union Street prompt runner or chat CLI.
---

# Agents Prompting Agents

Prompt the agent as an operator in an org, not as a function caller.

## Prompt Pattern

1. Give mission and constraints.
2. Tell the agent to inspect its direct reports before delegating.
3. Ask it to delegate selectively, not broadcast by default.
4. Require concise upward reports with evidence and blockers.
5. Require memory-worthy conclusions to be recorded.

## Avoid

- Listing impossible peer ids.
- Telling agents to call Lash directly by implementation detail.
- Over-steering every delegation edge.
- Asking weak models to infer hidden org topology.
