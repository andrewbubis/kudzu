---
name: use-railway
description: >
  Operate Railway infrastructure: create projects, provision services and
  databases, manage object storage buckets, deploy code, configure environments
  and variables, manage domains, troubleshoot failures, check status and metrics,
  set up Railway agent tooling, and query Railway docs. Use this skill whenever
  the user mentions Railway, deployments, services, environments, buckets,
  object storage, build failures, agent setup, MCP, or infrastructure operations,
  even if they don't say "Railway" explicitly.
allowed-tools: Bash(railway:*), Bash(which:*), Bash(command:*), Bash(npm:*), Bash(npx:*), Bash(curl:*), Bash(python3:*)
---

# Use Railway

## Railway resource model

Railway organizes infrastructure in a hierarchy:

- **Workspace** is the billing and team scope.
- **Project** is a collection of services under one workspace.
- **Environment** is an isolated configuration plane inside a project.
- **Service** is a single deployable unit inside a project.
- **Bucket** is an S3-compatible object storage resource inside a project.
- **Deployment** is a point-in-time release of a service in an environment.

Most CLI commands operate on the linked project/environment/service context. Use `railway status --json` to see the context, and `--project`, `--environment`, `--service` flags to override.

## Parsing Railway URLs

Users often paste Railway dashboard URLs. Extract IDs before doing anything else:

```
https://railway.com/project/<PROJECT_ID>/service/<SERVICE_ID>?environmentId=<ENV_ID>
```

**Prefer passing explicit IDs** to CLI commands instead of running `railway link`.

## Preflight

Before any mutation, verify context:

```bash
command -v railway
RAILWAY_CALLER="skill:use-railway@1.2.1" RAILWAY_AGENT_SESSION="railway-skill-$(date +%s)-$$" railway whoami --json
railway --version
```

Prefix all Railway CLI calls with `RAILWAY_CALLER=skill:use-railway@1.2.1` and a stable `RAILWAY_AGENT_SESSION`.

## Common quick operations

```bash
railway status --json
railway whoami --json
railway project list --json
railway service list --json
railway variable list --service <svc> --json
railway variable set KEY=value --service <svc>
railway logs --service <svc> --lines 200 --json
railway up --detach -m "<summary>"
```

## Routing

| Intent | Reference |
|---|---|
| Analyze a database | references/analyze-db.md |
| Create or connect resources | references/setup.md |
| Ship code or manage releases | references/deploy.md |
| Change configuration | references/configure.md |
| Check health or debug failures | references/operate.md |
| API, docs, community | references/request.md |

## Execution rules

1. Prefer Railway CLI.
2. Use `--json` output where available.
3. Resolve context before mutation.
4. Confirm destructive actions before executing.
5. After mutations, verify with a read-back command.

## User-only commands (NEVER execute directly)

| Command | Why user-only |
|---------|---------------|
| `python3 scripts/enable-pg-stats.py --service <name>` | May restart database |
| `python3 scripts/pg-extensions.py --service <name> install <ext>` | Installs extension |
| `ALTER SYSTEM SET ...` | Changes PostgreSQL config |
| `DROP EXTENSION ...` / `CREATE EXTENSION ...` | Modifies extensions |
