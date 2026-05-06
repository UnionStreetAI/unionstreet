---
name: creating-work-with-webhooks
description: Configure webhook ingress that creates Union Street work, validates signatures, maps sources to agents, and writes audit events. Use when external systems should wake agents.
license: MIT
compatibility: Requires Union Street runtime HTTP webhook routes and bearer/signature policy.
---

# Creating Work With Webhooks

Webhook ingress is a control-plane entry point. Treat it as security-sensitive.

## Rules

- Require bearer auth for mutating runtime APIs.
- Configure `US_WEBHOOK_<SOURCE>_SECRET` or `US_WEBHOOK_SECRET` for signed sources.
- Validate source ids and reject malformed payloads before agent work starts.
- Map source events to a target agent/profile intentionally.
- Audit accepted and rejected ingress.

After changes, test both accepted and rejected signatures.
