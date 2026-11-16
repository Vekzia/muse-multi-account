# Muse multi-account server v1.5

The Linux package runs the management WebUI, bearer-protected Fastify 5 API, per-account proxies, and persistent Cookie Jars. Tests use Vitest 4; persistence uses atomic JSON file replacement. It requires Node 20.19+ for local builds; the Docker image uses Node 22 Debian slim. Account metadata and Cookie Jars live under `MUSE_DATA_DIR` (default `./server-data`, relative to the process working directory).

## Local quick start

From the repository root:

```sh
cd server
cp .env.example .env
# Set MUSE_ACCESS_TOKEN in .env; generate a value with: openssl rand -hex 32
npm ci
npm test
npm run build
node --env-file=.env dist/server.js
```

Open `http://127.0.0.1:8787` and enter the token. `npm start` and `npm run dev` read the process environment; they do not load `.env` automatically. For development with the example file, use `node --env-file=.env --import tsx --watch src/server.ts`.

`GET /api/health` is public. All other management API paths require `Authorization: Bearer TOKEN`. The WebUI keeps the token in `sessionStorage` and exchanges a one-use launch token using POST for an account session cookie. It does not place either token in the URL. In local development without an explicit token, the CLI prints a random first-run token; production startup requires an explicit token.

## Docker Compose

From the repository root:

```sh
cp .env.example .env
# Set MUSE_ACCESS_TOKEN, MUSE_PUBLIC_HOST, and optionally MUSE_HOST_BIND in .env.
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8787/api/health
```

Alternatively run `docker compose --env-file ../.env up -d --build` from `server/`. Choose one compose project so both entry points do not contend for the same ports or create separate data volumes.

The image runs as `node` (UID 1000). Compose drops capabilities, enables `no-new-privileges`, and stores data in the named volume mounted at `/data/muse`. The image healthcheck uses Node's HTTP fetch to query `/api/health`; it requires no curl package. For bind mounts, create the target directory with ownership writable by UID 1000 before starting the container. Stop the service before taking a raw volume snapshot.

### LAN and domain access

The host mapping defaults to `127.0.0.1`. For LAN clients, set `MUSE_HOST_BIND=0.0.0.0` and `MUSE_PUBLIC_HOST` to the server's LAN IP or hostname. `MUSE_PUBLIC_HOST` is a host only, without a protocol, path, or port. Management uses port 8787; accounts use distinct origins on ports 8788–8819. Compose publishes both ranges. The current range maps IDs 1–32 to fixed ports; deleted IDs remain consumed by the monotonic allocator. Native deployments can adjust `MUSE_ACCOUNT_PORT_START` and `MUSE_ACCOUNT_PORT_COUNT`. Adjust Compose port mappings too when changing that range.

For a domain deployment, point DNS at the host and preserve each account's distinct port/origin through the reverse proxy. Collapsing accounts onto one origin shares browser storage. Wildcard subdomain mapping and TLS origin rewriting are not configured by the supplied Compose files; terminate TLS consistently for management and account origins before using a public domain.

## Backups

Both endpoints require the management bearer token:

```sh
curl --fail -H "Authorization: Bearer $MUSE_ACCESS_TOKEN" \
  http://127.0.0.1:8787/api/backup/export > muse-backup.json
curl --fail -H "Authorization: Bearer $MUSE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @muse-backup.json \
  'http://127.0.0.1:8787/api/backup/import?mode=merge'
```

The server envelope is UTF-8 JSON: `{ "app": "muse-multi-account-server", "schema": 1, "exportedAt": 0, "accounts": [], "cookies": [] }`. Every cookie entry is `{ "accountId": 1, "jar": <tough-cookie serialized jar> }`. Export preserves complete account metadata including proxy credentials and cookie scope/expiry/flags, so store exported files with the same access controls as the data volume. The default maximum import/export payload is 10 MiB.

- `merge` updates matching account IDs, appends new IDs, and keeps unrelated accounts and their Cookie Jars. Only supplied jars are restored.
- `replace` installs the incoming account set and clears existing jars before restoring those supplied. Empty replacement explicitly removes all accounts and jars.
- Schema, record types, duplicate account/jar IDs, cookie ownership, and payload size are checked before mutations. A runtime write failure triggers restoration of the previous accounts and touched jars; a rollback failure is reported explicitly. This is application-level rollback, not a crash-atomic transaction across all files.

This server JSON format is distinct from Android's backup payload and optional `MUSEBAK1:` AES-GCM passphrase envelope. The server does not encrypt backups or import Android files directly. No password-encryption compatibility is claimed.

## Cookie, proxy, and fingerprint behavior

Each account has one persistent Cookie Jar and one proxy configuration. HTTP/HTTPS/SOCKS5 proxies are parsed by the server; probe errors and ordinary API responses omit credentials. Only the configured Muse upstream is proxied. Backup files intentionally contain the full credentials needed for restoration.

Distinct account origins separate browser localStorage and IndexedDB, while server-side jars keep upstream Cookies separate. Browser GPU, font, screen, Canvas and WebGL properties still come from the client browser. Account UA/locale metadata does not provide full browser fingerprint isolation.

## Configuration and integration contracts

See [.env.example](.env.example). The main settings are `MUSE_BIND`, `MUSE_PORT`, `MUSE_ACCESS_TOKEN`, `MUSE_PUBLIC_HOST`, `MUSE_PUBLIC_PORT` (external management port), `MUSE_UPSTREAM_ORIGIN`, and `MUSE_DATA_DIR`. Production validates a nonempty token and startup validates host/port/origin values.

`exportBackup(store, jars)` and `importBackup(buffer, store, jars, mode)` are in [src/api/backup.ts](src/api/backup.ts). `AccountStoreLike` accepts `list/create/update/remove` and preferably atomic `replaceAll(accounts)`; incoming IDs must be preserved. The fallback CRUD adapter must preserve IDs, account order, and full metadata during rollback. `AccountCookieJar` integrates through `get/restore/clear`; serialized jars can also use explicit `export` and `save` adapters. The caller serializes imports, exports, account mutations and cookie writes, and revokes active sessions after restored credentials change. The server composition owns bearer protection and HTTP body limits.

## Verification and CI

```sh
cd server
npm ci
npm test
npm run build
docker build -t muse-multi-account-server .
```

The server workflow runs Node 20, `npm ci`, Vitest with a JUnit report, TypeScript build, Docker build, and a non-root container smoke test for health, WebUI assets, and authenticated API access. Reports are uploaded even if checks fail. Test upstreams are local fixtures; CI does not require live Muse credentials.

Android remains a separate project. From the repository root its regression command is `./gradlew --no-daemon --console=plain testDebugUnitTest lintDebug assembleDebug assembleRelease`.
