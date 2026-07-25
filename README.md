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
```

Requires Docker. Prefer official Debian-based images (e.g. `postgres:18`, `mysql:8`, `mariadb:11`). Avoid `*-alpine` Postgres images.

`init` creates `config.json` and `metadata.json` in the same directory. There is no example config file — use `init`.

## Commands / flags

| Command / flag | Description |
|----------------|-------------|
| `(default)` | Interactive dump / restore / sync / change master |
| `init` | Scaffold `config.json` + `metadata.json` (asks about fake data) |
| `init --with-fake-data` | Same, but skip the fake-data prompt and use samples |
| `-c, --config <path>` | Config path (default: `config.json`) |
| `--yes` | Skip overwrite confirms; auto-create missing destination DB |

```powershell
bun run dbsync
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
        "name": "app_db"
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
| `rememberPassword` | Store DB passwords in `metadata.json` (AES-256-GCM), unlocked by master password |
| `encryptedDump` | Encrypt dump files with the master-derived AES key |
| `dumpDirectory` | Base directory for dumps (default `.` → `./dumps`) |
| `*/image` | Docker image for that engine (optional; defaults shown above) |
| `*/items` | Named map of targets (key = dump folder label). Fields: `host`, `port`, `user`, `name` (database name). **No password field.** |

If `dumpDirectory` already ends with a `dumps` segment, that path is used as the dumps root; otherwise `{dumpDirectory}/dumps` is created. The tool checks the directory is writable before dumping.

## Security / metadata

When `rememberPassword` or `encryptedDump` is true, you set a **master password** at `init` and enter it on each run.

| Secret | Storage |
|--------|---------|
| Master password | **Argon2id** hash in `metadata.json` |
| DB passwords | **AES-256-GCM** ciphertext (key derived from master via Argon2id) |
| Encrypted dumps | Same AES key; filenames include `_encrypted` before the extension |

`metadata.json` shape:

```json
{
  "masterPassword": "<argon2id-encoded-hash>",
  "kdfSalt": "<base64>",
  "dbPasswords": {
    "postgres:prod": "<aes-256-gcm payload>"
  }
}
```

- Saved DB passwords are **reused** (decrypted) when present — you are not prompted again until connect fails.
- On connection failure: **Retry** or **Change password and retry** (updates encrypted metadata when remembering).
- Do not commit `metadata.json` with real secrets casually.

## Interactive modes

1. **Take dump and restore** — source → destination (file dump + restore; Postgres uses `pg_restore --jobs`)
2. **Take dump** — write a dump under `dumps/{engine}/{name}/`
3. **Restore from dump** — pick a dump file → destination
4. **Change master password** (if master is enabled) — re-AES all `dbPasswords` automatically, then choose:
   - **Re-encrypt dumps**
   - **Delete all dumps**

Dump progress uses an **ora** spinner with a live timer; on success it shows elapsed time and file size.

## Dumps layout

```text
dumps/
  postgres/
    prod/
      postgres_prod_2026-07-25_10-02-15.dump
      postgres_prod_2026-07-25_10-02-15_encrypted.dump   # if encryptedDump
    staging/
      postgres_staging_2026-07-25_11-00-00.dump
  mysql/
    local/
      mysql_local_2026-07-25_11-00-00.sql
```

Filenames: `{engine}_{name}_{yyyy-MM-dd_HH-mm-ss}[_encrypted].{dump|sql}`. Postgres uses `.dump` (custom + zstd); MySQL/MariaDB use `.sql`.

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
