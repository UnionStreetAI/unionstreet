---
name: billing-ops
description: Handle Stripe billing workflows with safe read-first behavior.
---

# Stripe Billing Ops

Default to read-only inspection. Treat refunds, cancellations, subscription
changes, invoice voiding, and webhook secret changes as high-impact operations
that require explicit approval.
