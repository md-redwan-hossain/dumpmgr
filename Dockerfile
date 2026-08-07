# Docker CLI for spawning pg_dump/pg_restore containers via the host socket.
FROM docker:27-cli AS dockercli

FROM oven/bun:1.2.21

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV DUMPMGR_CONFIG=/data/config.jsonc

CMD ["bun", "run", "src/index.ts", "autonomous", "-c", "/data/config.jsonc"]
