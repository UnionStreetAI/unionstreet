---
name: aws-cli
description: Use the AWS CLI for account-aware inspection and safe cloud operations. Covers identity, regions, logs, S3, CloudFormation, ECS, Lambda, and diagnostics.
---

# AWS CLI

Use `aws` for AWS inspection and operations. Start read-only and account-aware.

## Docs

- https://docs.aws.amazon.com/cli/latest/

## Checks

```sh
aws --version
aws sts get-caller-identity
aws configure list
aws configure get region
```

## Common Commands

```sh
aws sts get-caller-identity
aws logs describe-log-groups
aws logs tail <group> --follow
aws s3 ls
aws cloudformation describe-stacks
aws ecs list-clusters
aws lambda list-functions
```

## Rules

- Always name the account, region, and profile in summaries.
- Prefer `--profile` and `--region` over ambient assumptions.
- Ask before mutating IAM, networking, databases, or production workloads.
- Never print secrets, access keys, session tokens, or full env dumps.
