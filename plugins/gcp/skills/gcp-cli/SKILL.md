---
name: gcp-cli
description: Use the Google Cloud gcloud CLI for project-aware inspection and safe cloud operations. Covers auth, project config, logs, Cloud Run, builds, and storage.
---

# Google Cloud CLI

Use `gcloud` for Google Cloud inspection and operations. Start by pinning project and account.

## Docs

- https://docs.cloud.google.com/sdk/gcloud
- https://docs.cloud.google.com/docs/authentication/gcloud

## Checks

```sh
gcloud version
gcloud auth list
gcloud config list
gcloud config get-value project
```

## Common Commands

```sh
gcloud projects list
gcloud logging read 'severity>=ERROR' --limit=20
gcloud run services list
gcloud run services describe <service> --region <region>
gcloud builds list --limit=10
gcloud storage ls
```

## Rules

- Always name active account, project, and region.
- Prefer `--project` and `--region` over ambient assumptions.
- Ask before IAM, billing, networking, database, or production mutations.
- Never print service account keys or credential files.
