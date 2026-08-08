package doctor

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/docker"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/metadata"
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

	metaPath := metadata.PathForConfig(configPath)
	magic := checkMetadataMagic(metaPath)
	checks = append(checks, Check{Name: "metadata-magic", OK: magic.OK, Message: magic.Message, Hint: magic.Hint})

	if cfg.S3Options != nil {
		checks = append(checks, Check{
			Name:    "s3-config",
			OK:      true,
			Message: fmt.Sprintf("S3 configured: %s/%s", cfg.S3Options.Endpoint, cfg.S3Options.BucketName),
			Hint:    "S3 credentials are checked by `dumpmgr s3 upload` or `dumpmgr s3 download` after master unlock.",
		})
	}

	if magic.OK {
		meta, err := metadata.Load(metaPath)
		if err != nil {
			checks = append(checks, Check{
				Name:    "metadata-body",
				OK:      false,
				Message: fmt.Sprintf("cannot decode metadata body: %v", err),
			})
		} else {
			if config.NeedsMaster(cfg) {
				checks = append(checks, saltCheck(meta.KdfSalt != nil))
				checks = append(checks, masterHashCheck(meta.MasterPassword != nil))
			}
			if cfg.EncryptedDump {
				if meta.EncID != nil && *meta.EncID != "" {
					checks = append(checks, Check{
						Name:    "enc-id",
						OK:      true,
						Message: fmt.Sprintf("encId present (%s)", *meta.EncID),
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

type magicResult struct {
	OK      bool
	Message string
	Hint    string
}

func checkMetadataMagic(metaPath string) magicResult {
	data, err := os.ReadFile(metaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return magicResult{
				OK:      false,
				Message: fmt.Sprintf("metadata file not found at %s", metaPath),
				Hint:    "run `dumpmgr config init`",
			}
		}
		return magicResult{OK: false, Message: fmt.Sprintf("cannot read metadata at %s", metaPath)}
	}
	magic := metadata.Magic()
	if len(data) < len(magic)+1 {
		return magicResult{
			OK:      false,
			Message: "metadata file is too short",
			Hint:    "run `dumpmgr config init` to recreate",
		}
	}
	for i := range magic {
		if data[i] != magic[i] {
			return magicResult{
				OK:      false,
				Message: "metadata has bad magic (not a DBSM file)",
				Hint:    "delete the file and run `dumpmgr config init`",
			}
		}
	}
	version := data[len(magic)]
	if version != metadata.Version {
		return magicResult{
			OK:      false,
			Message: fmt.Sprintf("unsupported metadata version: %d", version),
			Hint:    fmt.Sprintf("expected version %d", metadata.Version),
		}
	}
	return magicResult{OK: true, Message: fmt.Sprintf("metadata magic OK (DBSM v%d)", version)}
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
