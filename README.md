# dumpmgr

**Dump Manager** — dump and restore **Postgres** databases through Docker, with interactive prompts, optional encrypted dumps, SQLite vault storage, and scheduled autonomous backups.

> **Note:** The TypeScript/Bun implementation lives on the [`legacy-ts-version`](https://github.com/md-redwan-hossain/dumpmgr/tree/legacy-ts-version) branch. `main` is Go-only.

## Setup

```bash
go build -o bin/dumpmgr ./src/cmd/dumpmgr
./bin/dumpmgr config init
# prompts: populate with fake sample data? then master password
# or skip the fake-data prompt:
./bin/dumpmgr config init --with-fake-data
# edit config.jsonc, then:
./bin/dumpmgr
```

Requires Docker. Prefer official Debian-based images (e.g. `postgres:18`). Avoid `*-alpine` Postgres images.

`config init` creates `config.jsonc` and `vault.db` in the same directory. Comments (`//`, `/* */`) and trailing commas are allowed in JSONC.

## Testing

```bash
make test          # or: go test ./...
make build
sqlc generate      # after editing vault SQL queries
```

## Commands / flags

| Command / flag | Description |
|----------------|-------------|
| `(default)` | Interactive dump / restore / sync / change master |
| `doctor` | Health check: Docker daemon, dumps dir, vault integrity |
| `s3 upload` / `s3 download` | Manual S3 upload/download |
| `secret list` / `secret history` / `secret wipe` | Manage stored DB passwords |
| `vault status` | SQLite vault summary |
| `audit list` | Audit log |
| `dump-registry {list,show,verify,scan}` | Dump SHA-256 registry |
| `restore-history list` | Restore history |
| `config {init,validate,lint}` | Config scaffolding and validation |
| `autonomous` | Run scheduled backups from `autonomous.schedules` |
| `autonomous --once` | Run all schedules immediately and exit |
| `-c, --config <path>` | Config path (default: `config.jsonc`) |
| `--yes` | Skip overwrite confirms |
| `--debug` | Print docker/DB commands |

```bash
./bin/dumpmgr
./bin/dumpmgr -c ./config.jsonc --yes
./bin/dumpmgr config init --with-fake-data
./bin/dumpmgr doctor
./bin/dumpmgr autonomous --once
```

## Autonomous mode (Docker Compose)

Run dumpmgr as a long-lived container on a **cron schedule** with optional S3 upload.

1. Prepare config and vault interactively once (store DB passwords):

```bash
./bin/dumpmgr config init --with-fake-data
# edit config.jsonc — add autonomous.schedules
./bin/dumpmgr dump   # connect once per DB so passwords are saved
```

2. Create `.env` next to `compose.yaml`:

```env
DUMPMGR_MASTER_PASSWORD=your-master-password
# optional if not already in vault:
# DUMPMGR_S3_SECRET_KEY=your-s3-secret-key
```

3. Start the scheduler:

```bash
docker compose up -d --build
docker compose logs -f dumpmgr
```

`compose.yaml` mounts `./config.jsonc`, `./vault.db`, and `./dumps`. Use `"dumpDirectory": "."` in config so dumps land in `./dumps` on the host.

### Config: `autonomous`

```jsonc
{
  "autonomous": {
    "schedules": [
      {
        "cron": "0 2 * * *",
        "items": ["prod"],
        "uploadToS3": true
      },
      {
        "cron": "0 */6 * * *"
      }
    ]
  }
}
```

| Field | Meaning |
|-------|---------|
| `cron` | Standard 5-field cron expression (UTC) |
| `items` | Optional item keys to dump; omit for all items |
| `uploadToS3` | Upload each dump to S3 (requires `s3Options`) |

### Environment variables (autonomous)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DUMPMGR_MASTER_PASSWORD` | When vault/S3/encryption enabled | Unlock vault without prompts |
| `DUMPMGR_S3_SECRET_KEY` | When uploading and key not in vault | S3 secret access key |
| `DUMPMGR_DOCKER_NETWORK` | Optional | Docker network for pg_dump containers |

### Local testing without Compose

```bash
DUMPMGR_MASTER_PASSWORD=secret ./bin/dumpmgr autonomous --once -c config.jsonc
```

## Config

JSONC with comments and trailing commas. `config lint` reformats in place and preserves comments.

Top-level fields: `rememberPassword`, `encryptedDump`, `dumpDirectory`, `image`, `s3Options`, `autonomous`, `items`.

Nested `items` under a parent inherit `host`/`port`; runtime key is `parent:child`. Password vault key: `postgres:parent:child`.

## Security / vault

Secrets are stored in **`vault.db`** (SQLite) next to `config.jsonc`:

| Secret | Storage |
|--------|---------|
| Master password | Argon2id hash in vault |
| DB passwords | AES-256-GCM ciphertext |
| Encrypted dumps | Master-derived AES key; `_enc_<encId>` in filename |
| Audit / dump registry | SQLite tables in same vault |

Legacy binary `metadata` / `metadata.json` is migrated to `vault.db` on first open (source renamed to `.bak`).

## Project layout

```text
src/
  cmd/dumpmgr/          CLI entrypoint
  internal/             application packages
    vault/              SQLite vault (sqlc-generated queries)
    autonomous/         cron scheduler
    ...
go.mod
sqlc.yaml
compose.yaml
Dockerfile
```

## Postgres tooling

| | |
|--|--|
| Dump | `pg_dump --format=custom --compress=zstd:5` |
| Restore | `pg_restore --jobs N` |
| Maintenance DB | `postgres` |

On Windows/macOS, `localhost` / `127.0.0.1` is rewritten to `host.docker.internal` inside containers.
