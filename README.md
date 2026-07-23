# dbsync

Copy a Postgres database from one named target to another using Docker (`postgres:18`), with interactive prompts and Zod-validated config.

## Setup

```powershell
bun install
copy config.json.example config.json
# edit config.json with your hosts / users / optional passwords
```

Use an official Debian-based image such as `postgres:18` or `postgres:18-bookworm`. Do **not** use `*-alpine` images.

## Usage

```powershell
bun run dbsync
# or
bun run src/index.ts -c .\config.json
```

Flags:

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Config file (default: `config.json`) |
| `--keep-dump` | Write a temp dump file, restore with parallel `-j`, and keep the file |
| `--yes` | Skip overwrite confirm; auto-create missing destination DB |

## Flow

1. Select source and destination from `config.json`
2. Prompt for passwords if not set in config
3. Verify both connections (source DB + dest server auth) before continuing
4. If destination DB is missing, ask to create it
5. Confirm overwrite
6. By default: stream `pg_dump -Fc --compress=zstd:5` stdout into `pg_restore --clean --if-exists --no-owner --no-acl` (no temp file)
7. With `--keep-dump`: dump to a file, then `pg_restore -j N` (N = min(CPU count, 8)) and keep the archive

Requires Docker. On Windows/macOS, `localhost` is rewritten to `host.docker.internal` inside containers.
