package main

import (
	"os"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/cli"
)

func main() {
	if err := cli.Execute(); err != nil {
		os.Exit(1)
	}
}
