# Docker CLI for spawning pg_dump/pg_restore containers via the host socket.
FROM docker:27-cli AS dockercli

FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY sqlc.yaml ./
COPY src ./src
RUN CGO_ENABLED=0 go build -o /dumpmgr ./src/cmd/dumpmgr

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=builder /dumpmgr /usr/local/bin/dumpmgr
WORKDIR /data
ENV DUMPMGR_CONFIG=/data/config.jsonc
CMD ["dumpmgr", "autonomous", "-c", "/data/config.jsonc"]
