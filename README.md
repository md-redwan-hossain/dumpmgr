# dumpmgr

**Dump Manager** — dump and restore **Postgres** databases through Docker, with interactive prompts, optional encrypted dumps, and AES-wrapped remembered DB passwords.

## Setup

```powershell
bun install
bun run dumpmgr config init
# prompts: populate with fake sample data? then master password
# or skip the fake-data prompt:
bun run dumpmgr config init --with-fake-data
# edit config.jsonc, then:
bun run dumpmgr
```

Requires Docker. Prefer official Debian-based images (e.g. `postgres:18`). Avoid `*-alpine` Postgres images.

`config init` creates `config.jsonc` and a binary `metadata` file in the same directory. There is no example config file — use `config init`. Comments (`//`, `/* */`) and trailing commas are allowed.

## Testing

```bash
bun run test:unit         # unit tests; no Docker required
bun run test:integration  # end-to-end tests; requires Docker + postgres:18
bun run test:all          # unit + integration
bun run typecheck
```

Unit tests use isolated temporary directories and do not modify the project config
or metadata files. Integration tests start an ephemeral `postgres:18` container,
run real `pg_dump` / `pg_restore` flows, and are skipped automatically when Docker
is unavailable.

## Commands / flags

| Command / flag | Description |
|----------------|-------------|
| `(default)` | Interactive dump / restore / sync / change master |
| `doctor` | Health check: Docker daemon, dumps dir permissions, metadata magic/version, kdfSalt/master hash presence |
| `s3 upload` | Interactively choose a local dump and upload it to configured S3 |
| `s3 download` | Browse configured S3 dump objects and download one under `dumps/` |
| `secret list` | List stored DB password keys (`postgres:<item>`); values are never displayed |
| `secret wipe <key>` | Remove a saved DB password by key (e.g. `postgres:prod`) |
| `config init` | Scaffold `config.jsonc` + binary `metadata` (asks about fake data) |
| `config init --with-fake-data` | Same, but skip the fake-data prompt and use samples |
| `config validate` | Validate `config.jsonc` and print a summary report |
| `config lint` | Format `config.jsonc` in place (2-space indent; **preserves comments**) |
| `autonomous` | Run scheduled backups from `autonomous.schedules` (cron + optional S3 upload) |
| `autonomous --once` | Run all configured schedules immediately once and exit |
| `-c, --config <path>` | Config path (default: `config.jsonc`) |
| `--yes` | Skip overwrite confirms; auto-create missing destination DB (flat restore only; never auto-drops) |

```powershell
bun run dumpmgr
bun run dumpmgr -c .\config.jsonc --yes
bun run dumpmgr config init --with-fake-data
bun run dumpmgr config validate
bun run dumpmgr config lint
bun run dumpmgr doctor
bun run dumpmgr secret list
bun run dumpmgr secret wipe postgres:prod
bun run dumpmgr autonomous --once
```

## Autonomous mode (Docker Compose)

Run dumpmgr as a long-lived container that takes backups on a **cron schedule** and optionally uploads them to S3. This is separate from the interactive CLI — all existing commands and flows stay the same.

The container mounts the host Docker socket (`/var/run/docker.sock`) so it can spawn ephemeral `postgres` images for `pg_dump`, same as the CLI.

### Quick start

1. Prepare config and metadata interactively once (store DB passwords in metadata):

```powershell
bun run dumpmgr config init --with-fake-data
# edit config.jsonc — add autonomous.schedules (see below)
bun run dumpmgr dump   # connect once per DB so passwords are saved in metadata
```

2. Create `.env` next to `docker-compose.yml`:

```env
DUMPMGR_MASTER_PASSWORD=your-master-password
# optional if not already stored in metadata via interactive s3 upload:
# DUMPMGR_S3_SECRET_KEY=your-s3-secret-key
```

3. Start the scheduler:

```powershell
docker compose up -d --build
docker compose logs -f dumpmgr
```

`docker-compose.yml` mounts `./config.jsonc`, `./metadata`, and `./dumps`, and sets `working_dir` to `/data`. Use `"dumpDirectory": "."` in config so dumps land in `./dumps` on the host.

### Config: `autonomous`

```jsonc
{
  "rememberPassword": true,
  "encryptedDump": false,
  "dumpDirectory": ".",
  "image": "postgres:18",
  "s3Options": {
    "endpoint": "https://s3.example.com",
    "accessKey": "your-access-key",
    "bucketName": "your-bucket",
    "useHttps": true,
    "forcePathStyle": true,
  },
  "autonomous": {
    "schedules": [
      {
        "cron": "0 2 * * *",       // daily at 02:00 UTC
        "items": ["prod"],         // omit or [] to dump all configured items
        "uploadToS3": true,        // requires s3Options
      },
      {
        "cron": "0 */6 * * *",     // every 6 hours — all items, local only
      },
    ],
  },
  "items": {
    "prod": {
      "host": "127.0.0.1",
      "port": 5432,
      "user": "db_user",
      "database": "app_db",
    },
  },
}
```

| Field | Meaning |
|-------|---------|
| `cron` | Cron expression (standard 5-field syntax, UTC) |
| `items` | Optional list of item keys (`prod`, `parent:child`). Empty/omitted dumps **all** items |
| `uploadToS3` | After each dump, upload to configured S3 (default `false`) |

### Environment variables (autonomous)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DUMPMGR_MASTER_PASSWORD` | When `rememberPassword`, `encryptedDump`, or `s3Options` | Unlock metadata without prompts |
| `DUMPMGR_S3_SECRET_KEY` | When uploading and key not in metadata | S3 secret access key |
| `DUMPMGR_DOCKER_NETWORK` | Optional | Docker network for pg_dump containers (compose default: `host` on Linux) |

DB passwords must already be stored in `metadata` (run an interactive dump once per database). Autonomous mode does not prompt.

### Local testing without Compose

```powershell
$env:DUMPMGR_MASTER_PASSWORD="your-master"
bun run dumpmgr autonomous --once -c config.jsonc
```

## Config

JSONC: `//` line comments, `/* */` block comments, and trailing commas are allowed. `config lint` reformats and **preserves** comments.

```jsonc
{
  "rememberPassword": true,
  "encryptedDump": false,
  "dumpDirectory": ".",
  "image": "postgres:18", // Docker image for pg_dump / pg_restore
  "s3Options": {
    "endpoint": "https://s3.example.com",
    "accessKey": "your-access-key",
    "bucketName": "your-bucket",
    "createBucketIfNotExists": false,
    "useHttps": true,
    "region": "us-east-1",
    "forcePathStyle": true,
  },
  "items": {
    "prod": {
      "host": "127.0.0.1",
      "port": 5432,
      "user": "db_user",
      "database": "app_db",
      "readonly": false,
    },
    "local_dev_docker": {
      "host": "localhost",
      "port": 5437,
      "user": "retailr_user",
      "database": "retailr_db",
      "readonly": true,
      "items": {
        "dump": {
          "database": "retailr_db_copy",
        },
      },
    },
  },
}
```

| Field | Meaning |
|-------|---------|
| `rememberPassword` | Store DB passwords in binary `metadata` (AES-256-GCM), unlocked by master password |
| `encryptedDump` | Encrypt dump files with the master-derived AES key |
| `dumpDirectory` | Base directory for dumps (default `.` → `./dumps`) |
| `image` | Docker image (optional; default `postgres:18`) |
| `s3Options` | Optional S3-compatible storage settings for manual upload/download |
| `items` | Named map of targets. Fields: `host`, `port`, `user`, `database`, `readonly` (default `false`). **No password field.** |

### Nested items (one level)

A parent may include nested `items`. Children set `database` (and optionally `user`) and **inherit** parent `host` / `port`. Omit child `user` to use the parent's user.

- Runtime key: `parent:child` (e.g. `local_dev_docker:dump`)
- Password metadata key: `postgres:local_dev_docker:dump`
- Dump folder: `dumps/local_dev_docker/dump/`

`config init` always emits `"readonly": false` on scaffolded top-level entries.

### `readonly`

Only meaningful on parents that have nested `items` (destination / restore tree):

| Setting | Restore destination tree |
|---------|--------------------------|
| `readonly: true` + nested items | Parent shown but **not selectable**; only nested children can be chosen |
| `readonly: true` + no nested items | Entry hidden entirely |
| `readonly: false` | Parent and children shown |

Dump source picker can still select the parent even when `readonly` is true.

If `dumpDirectory` already ends with a `dumps` segment, that path is used as the dumps root; otherwise `{dumpDirectory}/dumps` is created. The tool checks the directory is writable before dumping.

### S3-compatible storage

S3 support uses Bun's native `S3Client`; no AWS SDK dependency is required. It is
manual and separate from the normal dump/restore flow:

```powershell
bun run dumpmgr s3 upload
bun run dumpmgr s3 download
```

The `endpoint`, `accessKey`, `bucketName`, `createBucketIfNotExists`,
`useHttps`, optional `region`, and `forcePathStyle` fields are lower camel case.
The secret access key is never placed in JSON. On first S3 use, dumpmgr prompts
for it and stores AES-256-GCM ciphertext in the binary `metadata` file, protected
by the master password. Existing buckets must be created ahead of time because
Bun's native S3 API does not expose bucket creation.

Uploads preserve the local dump layout as object keys, for example
`prod/prod_2026-07-25_10-02-15.dump`. Downloads recreate that layout below the
configured dumps root and reject path traversal keys. The interactive menu also
contains the upload and download actions when `s3Options` is configured.

## Security / metadata

When `rememberPassword` or `encryptedDump` is true, you set a **master password** at `config init` and enter it on each run.

| Secret | Storage |
|--------|---------|
| Master password | **Argon2id** hash inside binary `metadata` |
| DB passwords | **AES-256-GCM** ciphertext (key derived from master via Argon2id) |
| Encrypted dumps | Same AES key; filenames include `_enc_<encId>` before the extension |
| `encId` | UUID without hyphens, uppercase; stored in `metadata`; ties encrypted dumps to this vault |

`metadata` is a **binary** file (magic `DBSM` + gzip JSON), similar in spirit to `bun.lockb` — not casually readable/editable as text. It is **not** an extra encryption layer; real crypto is Argon2 + AES for secrets/dumps.

On first load, legacy `metadata.json` is migrated once to binary `metadata` and then removed.

- Saved DB passwords are **reused** (decrypted) when present — you are not prompted again until connect fails.
- On connection failure: **Retry** or **Change password and retry** (updates encrypted metadata when remembering).
- Do not commit `metadata` with real secrets casually.

## Interactive modes

1. **Take dump** — write a dump under `dumps/…`
2. **Restore from dump** — browse dump files → destination
3. **Take dump and restore** — source → destination
4. **Change master password** (if master is enabled) — re-AES all `dbPasswords`; if encrypted dumps matching this vault’s `encId` exist, choose:
   - **Re-encrypt dumps**
   - **Delete matching encrypted dumps**  
   If none match, that prompt is skipped.

### Restore UX

- **Dump picker:** interactive folder browser under `dumps/` (`..`, folders, files).
- **Destination:** tree-style list (`└` for nested children).
- **Nested destination:** verify parent connection, then try child:
  - Child reachable → **Yes** / **Drop database and restore** / **No**
  - Child missing → **Create database and restore** / **No**  
  (**No** is always last; no **Yes** when the child DB does not exist.)

Dump progress uses an **ora** spinner with a live timer; on success it shows elapsed time and file size.

## Dumps layout

```text
dumps/
  prod/
    prod_2026-07-25_10-02-15.dump
    prod_2026-07-25_10-02-15_enc_A1B2….dump   # if encryptedDump
  local_dev_docker/
    dump/
      local_dev_docker__dump_2026-07-25_11-00-00.dump
```

Filenames: `{key}_{utcTimestamp}[_enc_<encId>].dump`.

- Timestamp is **UTC** (`yyyy-MM-dd_HH-mm-ss`).
- Nested keys use `:` in config/runtime; `__` in the filename mid-key.
- Format is Postgres custom + zstd (`.dump`).

## Postgres tooling

Inside Docker:

| | |
|--|--|
| Dump | `pg_dump --format=custom --compress=zstd:5` |
| Restore | `pg_restore --jobs N` |
| Maintenance DB | `postgres` |

On Windows/macOS, `localhost` / `127.0.0.1` is rewritten to `host.docker.internal` inside containers.

## Missing config

If `config.jsonc` is missing, dumpmgr shows an error and offers to run **config init** with or without fake data, then exits so you can edit the config before dumping/restoring.
