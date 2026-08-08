.PHONY: build test sqlc install

build:
	go build -o bin/dumpmgr ./src/cmd/dumpmgr

test:
	go test ./...

sqlc:
	sqlc generate

install:
	go install ./src/cmd/dumpmgr
