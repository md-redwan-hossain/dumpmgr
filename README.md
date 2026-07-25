# dbsync

Dump and sync **Postgres**, **MySQL**, and **MariaDB** databases through Docker, with interactive prompts, optional encrypted dumps, and AES-wrapped remembered DB passwords.

## Setup

```powershell
bun install
bun run dbsync init
# prompts: populate with fake sample data? then master password
# or skip the fake-data prompt:
bun run dbsync init --with-fake-data
# edit config.json, then:
bun run dbsync
# or lock the engine:
bun run dbsync pg
```

Requires Docker. Prefer official Debian-based images (e.g. `postgres:18`, `mysql:8`, `mariadb:11`). Avoid `*-alpine` Postgres images.

`init` creates `config.json` and a binary `metadata` file in the same directory. There is no example config file — use `init`.

## Commands / flags

| Command / flag | Description |
|----------------|-------------|
| `(default)` | Interactive dump / restore / sync / change master (prompts for engine) |
| `pg` / `postgres` | Same, locked to Postgres (skips engine prompt) |
| `mysql` | Locked to MySQL |
| `mariadb` | Locked to MariaDB |
| `init` | Scaffold `config.json` + binary `metadata` (asks about fake data) |
| `init --with-fake-data` | Same, but skip the fake-data prompt and use samples |
| `-c, --config <path>` | Config path (default: `config.json`) |
| `--yes` | Skip overwrite confirms; auto-create missing destination DB (flat restore only; never auto-drops) |

```powershell
bun run dbsync
bun run dbsync pg
bun run dbsync -c .\config.json --yes
bun run dbsync init --with-fake-data
```

## Config

```json
{
  "rememberPassword": true,
  "encryptedDump": false,
  "dumpDirectory": ".",
  "postgres": {
    "image": "postgres:18",
    "items": {
      "prod": {
        "host": "127.0.0.1",
        "port": 5432,
        "user": "db_user",
        "database": "app_db",
        "readonly": false
      },
      "local_dev_docker": {
        "host": "localhost",
        "port": 5437,
        "user": "retailr_user",
        "database": "retailr_db",
        "readonly": true,
        "items": {
          "dump": {
            "user": "retailr_user",
            "database": "retailr_db_copy"
          }
        }
      }
    }
  },
  "mysql": {
    "image": "mysql:8",
    "items": {}
  },
  "mariadb": {
    "image": "mariadb:11",
    "items": {}
  }
}
```

| Field | Meaning |
|-------|---------|
| `rememberPassword` | Store DB passwords in binary `metadata` (AES-256-GCM), unlocked by master password |
| `encryptedDump` | Encrypt dump files with the master-derived AES key |
| `dumpDirectory` | Base directory for dumps (default `.` → `./dumps`) |
| `*/image` | Docker image for that engine (optional; defaults shown above) |
| `*/items` | Named map of targets. Fields: `host`, `port`, `user`, `database`, `readonly` (default `false`). **No password field.** |

### Nested items (one level)

A parent may include nested `items`. Children only set `user` + `database` and **inherit** parent `host` / `port`.

- Runtime key: `parent:child` (e.g. `local_dev_docker:dump`)
- Password metadata key: `postgres:local_dev_docker:dump`
- Dump folder: `dumps/postgres/local_dev_docker/dump/`

`init` always emits `"readonly": false` on scaffolded top-level entries.

### `readonly`

Only meaningful on parents that have nested `items` (destination / restore tree):

| Setting | Restore destination tree |
|---------|--------------------------|
| `readonly: true` + nested items | Parent shown but **not selectable**; only nested children can be chosen |
| `readonly: true` + no nested items | Entry hidden entirely |
| `readonly: false` | Parent (if it has user+database) and children shown |

Dump source picker can still select the parent even when `readonly` is true.

If `dumpDirectory` already ends with a `dumps` segment, that path is used as the dumps root; otherwise `{dumpDirectory}/dumps` is created. The tool checks the directory is writable before dumping.

## Security / metadata

When `rememberPassword` or `encryptedDump` is true, you set a **master password** at `init` and enter it on each run.

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

1. **Take dump** — write a dump under `dumps/{engine}/…`
2. **Restore from dump** — browse dump files → destination
3. **Take dump and restore** — source → destination
4. **Change master password** (if master is enabled) — re-AES all `dbPasswords`; if encrypted dumps matching this vault’s `encId` exist, choose:
   - **Re-encrypt dumps**
   - **Delete matching encrypted dumps**  
   If none match, that prompt is skipped.

### Restore UX

- **Dump picker:** interactive folder browser under `dumps/{engine}/` (`..`, folders, files).
- **Destination:** tree-style list (`└` for nested children).
- **Nested destination:** verify parent connection, then try child:
  - Child reachable → **Yes** / **Drop database and restore** / **No**
  - Child missing → **Create database and restore** / **No**  
  (**No** is always last; no **Yes** when the child DB does not exist.)

Dump progress uses an **ora** spinner with a live timer; on success it shows elapsed time and file size.

## Dumps layout

```text
dumps/
  postgres/
    prod/
      postgres_prod_2026-07-25_10-02-15.dump
      postgres_prod_2026-07-25_10-02-15_enc_A1B2….dump   # if encryptedDump
    local_dev_docker/
      dump/
        postgres_local_dev_docker__dump_2026-07-25_11-00-00.dump
  mysql/
    local/
      mysql_local_2026-07-25_11-00-00.sql
```

Filenames: `{engine}_{key}_{utcTimestamp}[_enc_<encId>].{dump|sql}`.

- Timestamp is **UTC** (`yyyy-MM-dd_HH-mm-ss`).
- Nested keys use `:` in config/runtime; `__` in the filename mid-key.
- Postgres uses `.dump` (custom + zstd); MySQL/MariaDB use `.sql`.

## Engines

Same workflow for all three. Tooling differs inside Docker:

| | Postgres | MySQL / MariaDB |
|--|----------|-----------------|
| Dump | `pg_dump --format=custom --compress=zstd:5` | `mysqldump` / `mariadb-dump` |
| Restore | `pg_restore --jobs N` | `mysql` / `mariadb` client |
| Maintenance DB | `postgres` | `mysql` |

On Windows/macOS, `localhost` / `127.0.0.1` is rewritten to `host.docker.internal` inside containers.

Cross-engine sync (e.g. Postgres → MySQL) is not supported.

## Missing config

If `config.json` is missing, dbsync shows an error and offers to run **init** with or without fake data, then exits so you can edit the config before syncing.
