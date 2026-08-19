# Quality Guidelines

> Code quality standards for backend development.

## Scenario: Optional Docker Deployment

### 1. Scope / Trigger

- Trigger: changing the Dockerfile, Compose topology, OpenClaw plugin versions, host hook bootstrap, or persisted runtime paths.
- The Docker path is optional, but it must preserve the same notification-center behavior as the native Windows deployment.

### 2. Signatures

- Start: `.\scripts\docker-start.ps1 [-SkipBuild]`
- Stop without deleting state: `.\scripts\docker-stop.ps1`
- Host hooks: `.\scripts\install-hooks.ps1 [-ConfigureNotifications] [-Python <path>] [-VenvPath <path>]`
- Container entrypoint: `/app/scripts/docker-entrypoint.sh <command...>`

### 3. Contracts

- `monitor` serves the Nest API and Vue assets on container port `8787`.
- `openclaw` serves the Gateway on container port `18789` and becomes healthy before `monitor` starts.
- `./data:/app/data` contains SQLite, local credentials, bindings, and generated hook targets. `data/.gitignore` ignores every sibling entry while keeping the runtime directory in Git.
- `openclaw-data:/home/node/.openclaw` persists robot plugins, login state, and credentials across container replacement.
- `CODEX_SESSIONS_PATH` is mounted read-only at `/codex-sessions`.
- `AIMONITOR_INGEST_TOKEN` and `OPENCLAW_GATEWAY_TOKEN` are generated when blank and are never committed.
- The image pins Node, OpenClaw, Apprise, QQ, and Weixin versions. The runtime entrypoint verifies the exact plugin versions and uses OpenClaw `plugins install --force --pin` only when an existing volume has drifted.
- Host hooks require Python 3.12+. `install-hooks.ps1` may create a minimal venv and install the root Python project, but must not require a host Node build for Docker deployments.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Docker CLI missing | Stop before changing `.env`; report that Docker Desktop is required. |
| Docker Engine unavailable | Stop before Compose; report that Docker Desktop must be started. |
| Required Gateway token remains blank | `docker compose config` fails with an actionable interpolation error. |
| OpenClaw plugin missing | Install the exact pinned package, then verify `status=loaded` and package version. |
| OpenClaw plugin has the wrong version | Replace it with `--force --pin`, then verify again. |
| Weixin plugin layout is unsupported | Fail container startup instead of silently skipping the compatibility patch. |
| Host venv missing | Find Python 3.12+, create the requested venv, and install hook dependencies. |
| Host venv uses Python below 3.12 | Fail with the venv path and required version. |

### 5. Good/Base/Bad Cases

- Good: a fresh machine runs `docker-start.ps1`, receives random tokens, starts both healthy services, installs host hooks, and preserves data after `docker-stop.ps1` plus restart.
- Base: an existing valid OpenClaw volume starts without npm access because plugin verification performs no install.
- Bad: an old volume contains Weixin 2.4.5; startup must replace it with 2.4.6 or fail clearly, never report a healthy incompatible Gateway.

### 6. Tests Required

- Run PowerShell AST parsing for every deployment script under Windows PowerShell 5.1.
- Run `node --check` for entrypoint helper scripts and exercise the no-change plugin verification path against a loaded fixed-version registry.
- Run `docker compose config`, build the image from a clean context, and verify both health checks when Docker is available.
- Test fresh volume, repeated restart, and old-version volume recovery.
- Assert `data/monitor.db` and generated binding/target files are ignored while `data/.gitignore` is not ignored.
- Run the existing TypeScript/Python tests, type checks, and production build because the Dockerfile consumes their outputs.

### 7. Wrong vs Correct

#### Wrong

```dockerfile
COPY apps ./apps
RUN npm run build
```

This omits the root `tsconfig.base.json` extended by both workspaces, so a local build can pass while the clean Docker context fails.

#### Correct

```dockerfile
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps ./apps
RUN npm run build
```

## General Checklist

- Do not commit runtime databases, credentials, bindings, caches, or generated hook targets.
- Keep shell entrypoints at LF through `.gitattributes`.
- Prefer structured JSON parsing for external CLI metadata.
- Pin externally installed runtime components and verify the loaded version after recovery.
