package main

import (
	"os"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/cli"
)

func main() {
	if err := cli.Execute(); err != nil {
		os.Exit(1)
	}
}
