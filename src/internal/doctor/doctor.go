package doctor

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/docker"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/vault"
)

type Check struct {
	Name    string
	OK      bool
	Message string
	Hint    string
}

type Report struct {
	OK     bool
	Checks []Check
}

func Run(cfg *config.Config, configPath string) Report {
	var checks []Check

	if err := docker.AssertAvailable(); err != nil {
		checks = append(checks, Check{
			Name:    "docker",
			OK:      false,
			Message: err.Error(),
			Hint:    "start Docker Desktop / the docker daemon and retry",
		})
	} else {
		ver, _ := docker.Version()
		checks = append(checks, Check{Name: "docker", OK: true, Message: ver})
	}

	dumpsRoot := dumps.ResolveRoot(cfg.DumpDirectory)
	parent := filepath.Dir(dumpsRoot)
	if err := probeParentDir(parent); err != nil {
		checks = append(checks, Check{Name: "dumps-parent", OK: false, Message: err.Error()})
	} else {
		checks = append(checks, Check{
			Name:    "dumps-parent",
			OK:      true,
			Message: fmt.Sprintf("parent dir writable: %s", parent),
		})
	}

	if err := dumps.EnsureRootWritable(dumpsRoot); err != nil {
		checks = append(checks, Check{Name: "dumps-root", OK: false, Message: err.Error()})
	} else {
		checks = append(checks, Check{
			Name:    "dumps-root",
			OK:      true,
			Message: fmt.Sprintf("dumps dir writable: %s", dumpsRoot),
		})
	}

	vaultPath := metadata.DBPathForConfig(configPath)
	vaultCheck := checkVault(vaultPath)
	checks = append(checks, Check{Name: "vault-db", OK: vaultCheck.OK, Message: vaultCheck.Message, Hint: vaultCheck.Hint})

	if cfg.S3Options != nil {
		checks = append(checks, Check{
			Name:    "s3-config",
			OK:      true,
			Message: fmt.Sprintf("S3 configured: %s/%s", cfg.S3Options.Endpoint, cfg.S3Options.BucketName),
			Hint:    "S3 credentials are checked by `dumpmgr s3 upload` or `dumpmgr s3 download` after master unlock.",
		})
	}

	if vaultCheck.OK {
		store, err := vault.Open(configPath)
		if err != nil {
			checks = append(checks, Check{
				Name:    "vault-body",
				OK:      false,
				Message: fmt.Sprintf("cannot open vault: %v", err),
			})
		} else {
			defer store.Close()
			if config.NeedsMaster(cfg) {
				hasMaster, _ := store.HasMaster()
				checks = append(checks, masterHashCheck(hasMaster))
				checks = append(checks, saltCheck(hasMaster))
			}
			if cfg.EncryptedDump {
				encID, _ := store.EncID()
				if encID != "" {
					checks = append(checks, Check{
						Name:    "enc-id",
						OK:      true,
						Message: fmt.Sprintf("encId present (%s)", encID),
					})
				} else {
					checks = append(checks, Check{
						Name:    "enc-id",
						OK:      false,
						Message: "encId missing",
						Hint:    "encId is generated on next successful master unlock",
					})
				}
			}
		}
	}

	ok := true
	for _, c := range checks {
		if !c.OK {
			ok = false
			break
		}
	}
	return Report{OK: ok, Checks: checks}
}

func probeParentDir(parent string) error {
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	probe := filepath.Join(parent, fmt.Sprintf(".dumpmgr-doctor-%d", os.Getpid()))
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return fmt.Errorf("parent directory is not writable: %s", parent)
	}
	_ = os.Remove(probe)
	return nil
}

type vaultResult struct {
	OK      bool
	Message string
	Hint    string
}

func checkVault(vaultPath string) vaultResult {
	if _, err := os.Stat(vaultPath); os.IsNotExist(err) {
		return vaultResult{
			OK:      false,
			Message: fmt.Sprintf("vault database not found at %s", vaultPath),
			Hint:    "run `dumpmgr config init`",
		}
	} else if err != nil {
		return vaultResult{OK: false, Message: fmt.Sprintf("cannot read vault at %s", vaultPath)}
	}
	return vaultResult{OK: true, Message: fmt.Sprintf("vault database OK (%s)", vaultPath)}
}

func saltCheck(ok bool) Check {
	if ok {
		return Check{Name: "kdf-salt", OK: true, Message: "kdfSalt present"}
	}
	return Check{
		Name:    "kdf-salt",
		OK:      false,
		Message: "kdfSalt missing",
		Hint:    "run `dumpmgr config init` to set a master password",
	}
}

func masterHashCheck(ok bool) Check {
	if ok {
		return Check{Name: "master-hash", OK: true, Message: "master password hash present"}
	}
	return Check{
		Name:    "master-hash",
		OK:      false,
		Message: "master password hash missing",
		Hint:    "run `dumpmgr config init` to set a master password",
	}
}
