package initcmd

import (
	"fmt"
	"os"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/prompt"
)

type Options struct {
	Config       string
	WithFakeData *bool
}

func Run(opts Options) error {
	configPath := config.ResolvePath(opts.Config)
	metaPath := metadata.PathForConfig(configPath)

	if config.Exists(configPath) {
		overwrite, err := prompt.ConfirmInitOverwrite(configPath)
		if err != nil {
			return err
		}
		if !overwrite {
			fmt.Println("Init aborted.")
			os.Exit(0)
		}
	}

	withFakeData := false
	if opts.WithFakeData != nil {
		withFakeData = *opts.WithFakeData
	} else {
		fake, err := prompt.ConfirmFakeData()
		if err != nil {
			return err
		}
		withFakeData = fake
	}

	cfg := config.DefaultConfigScaffold(withFakeData)
	if err := config.Write(configPath, cfg); err != nil {
		return err
	}

	if config.NeedsMaster(&cfg) {
		existing, err := metadata.Load(metaPath)
		if err != nil {
			return err
		}
		hasMaster := existing.MasterPassword != nil && existing.KdfSalt != nil

		if hasMaster {
			action, err := prompt.SelectMasterAction()
			if err != nil {
				return err
			}
			if action == "continue" {
				fmt.Println("Keeping existing master password and saved DB secrets")
			} else {
				current, err := prompt.Password("current master password")
				if err != nil {
					return err
				}
				session, err := metadata.Unlock(metaPath, current)
				if err != nil {
					return err
				}
				next, err := promptNewMasterPair()
				if err != nil {
					return err
				}
				if _, err := metadata.ChangeMasterPassword(session, next); err != nil {
					return err
				}
				fmt.Println("✓ Master password updated")
			}
		} else {
			master, err := promptNewMasterPair()
			if err != nil {
				return err
			}
			if _, err := metadata.CreateWithMaster(metaPath, master); err != nil {
				return err
			}
		}
	} else {
		if _, err := metadata.Empty(metaPath); err != nil {
			return err
		}
	}

	fmt.Printf("✓ Wrote %s\n", configPath)
	if config.NeedsMaster(&cfg) {
		fmt.Printf("✓ metadata ready at %s\n", metaPath)
	} else {
		fmt.Printf("✓ Wrote %s\n", metaPath)
	}
	if withFakeData {
		fmt.Println("Edit config.jsonc (replace fake database and S3 settings) before running dumpmgr.")
	} else {
		fmt.Println("Add database items to config.jsonc, then run dumpmgr.")
	}
	return nil
}

func promptNewMasterPair() (string, error) {
	master, err := prompt.Password("master password (used for remembered DB secrets / dump encryption)")
	if err != nil {
		return "", err
	}
	confirm, err := prompt.Password("confirm master password")
	if err != nil {
		return "", err
	}
	if confirm != master {
		fmt.Println("Master passwords do not match.")
		os.Exit(1)
	}
	return master, nil
}
