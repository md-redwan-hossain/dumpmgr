.PHONY: build test lint sqlc

build:
	go build -o bin/dumpmgr ./cmd/dumpmgr

test:
	go test ./...

sqlc:
	sqlc generate

install:
	go install ./cmd/dumpmgr
