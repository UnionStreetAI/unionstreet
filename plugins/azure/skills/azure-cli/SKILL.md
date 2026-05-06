---
name: azure-cli
description: Use the Azure CLI for subscription-aware inspection and safe cloud operations. Covers login, subscriptions, resource groups, deployments, app services, container apps, and monitor logs.
---

# Azure CLI

Use `az` for Azure inspection and operations. Start by confirming subscription context.

## Docs

- https://learn.microsoft.com/en-us/cli/azure/get-started-with-azure-cli
- https://learn.microsoft.com/en-us/cli/azure/reference-index

## Checks

```sh
az version
az account show
az account list --output table
```

## Common Commands

```sh
az login
az account set --subscription <subscription>
az group list --output table
az deployment group list --resource-group <rg>
az webapp list --output table
az containerapp list --output table
az monitor activity-log list --max-events 20
```

## Rules

- Always name subscription, tenant, resource group, and region.
- Prefer explicit `--subscription` and `--resource-group`.
- Ask before IAM/RBAC, networking, database, or production mutations.
- Never print service principal secrets or credential JSON.
