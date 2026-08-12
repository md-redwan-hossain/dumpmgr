package app

import (
	"fmt"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/docker"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/prompt"
)

type PrepareRestoreDestinationOpts struct {
	Config         *config.Config
	Session        *metadata.Session
	DestItem       config.DatabaseItem
	Image          string
	Yes            bool
	ConfirmMessage string
}

type PrepareRestoreDestinationResult struct {
	Cancelled    bool
	DestDB       docker.ResolvedDB
	IntoExisting bool
}

// PrepareRestoreDestination handles flat and nested destination setup for restore and dump-restore.
func PrepareRestoreDestination(opts PrepareRestoreDestinationOpts) (PrepareRestoreDestinationResult, error) {
	cfg := opts.Config
	session := opts.Session
	destItem := opts.DestItem
	image := opts.Image
	yes := opts.Yes
	confirmMessage := opts.ConfirmMessage

	if destItem.Nested && destItem.ParentKey != "" {
		parentItem := config.GetParentItem(cfg, destItem.ParentKey)
		if parentItem == nil {
			return PrepareRestoreDestinationResult{}, fmt.Errorf(
				`nested destination %q needs parent %q with user+database for connection verify`,
				destItem.Key, destItem.ParentKey,
			)
		}

		prompt.LogStep(fmt.Sprintf("Verifying parent %q…", parentItem.Key))
		parentDB, err := resolveConnectedDB(cfg, session, *parentItem, "destination", false)
		if err != nil {
			return PrepareRestoreDestinationResult{}, err
		}
		prompt.LogSuccess(fmt.Sprintf("Parent %q OK", parentItem.Key))

		parentLogin := parentDB.Database
		childTarget := docker.ResolvedDB{
			DatabaseItem: config.DatabaseItem{
				Key: destItem.Key, Host: parentDB.Host, Port: parentDB.Port,
				User: parentDB.User, Database: destItem.Database, Nested: true, ParentKey: destItem.ParentKey,
			},
			Password: parentDB.Password,
		}
		childExists, err := docker.DatabaseExists(image, childTarget, parentLogin)
		if err != nil {
			return PrepareRestoreDestinationResult{}, err
		}

		action, err := prompt.SelectNestedRestoreAction(confirmMessage, childExists)
		if err != nil {
			return PrepareRestoreDestinationResult{}, err
		}
		if action == prompt.NestedNo {
			return PrepareRestoreDestinationResult{Cancelled: true}, nil
		}

		if action == prompt.NestedDrop {
			prompt.LogStep(fmt.Sprintf("Dropping database %q…", destItem.Database))
			if err := docker.DropDatabase(image, childTarget, parentLogin); err != nil {
				return PrepareRestoreDestinationResult{}, err
			}
			prompt.LogStep(fmt.Sprintf("Creating database %q…", destItem.Database))
			if err := docker.CreateDatabase(image, childTarget, parentLogin); err != nil {
				return PrepareRestoreDestinationResult{}, err
			}
			prompt.LogSuccess(fmt.Sprintf("Recreated %q", destItem.Database))
		} else if action == prompt.NestedCreate {
			prompt.LogStep(fmt.Sprintf("Creating database %q…", destItem.Database))
			if err := docker.CreateDatabase(image, childTarget, parentLogin); err != nil {
				return PrepareRestoreDestinationResult{}, err
			}
			prompt.LogSuccess(fmt.Sprintf("Created %q", destItem.Database))
		}

		if action == prompt.NestedCreate || action == prompt.NestedDrop {
			if parentDB.User == destItem.User {
				item := destItem
				item.User = parentDB.User
				return PrepareRestoreDestinationResult{
					DestDB:       docker.ResolvedDB{DatabaseItem: item, Password: parentDB.Password},
					IntoExisting: false,
				}, nil
			}

			childKey := config.DBKey(destItem.Key)
			var saved string
			if session != nil && cfg.RememberPassword {
				saved, _ = metadata.GetDBPassword(session, childKey)
			}
			var pwSource prompt.NestedCreatePasswordSource
			if yes {
				pwSource = prompt.PasswordParent
			} else {
				pwSource, err = prompt.SelectNestedCreatePassword(saved != "")
				if err != nil {
					return PrepareRestoreDestinationResult{}, err
				}
			}

			switch pwSource {
			case prompt.PasswordParent:
				item := destItem
				item.User = parentDB.User
				return PrepareRestoreDestinationResult{
					DestDB:       docker.ResolvedDB{DatabaseItem: item, Password: parentDB.Password},
					IntoExisting: false,
				}, nil
			case prompt.PasswordSaved:
				if saved == "" {
					return PrepareRestoreDestinationResult{}, fmt.Errorf("no saved password for %q", destItem.Key)
				}
				return PrepareRestoreDestinationResult{
					DestDB:       docker.ResolvedDB{DatabaseItem: destItem, Password: saved},
					IntoExisting: false,
				}, nil
			case prompt.PasswordNew:
				password, err := prompt.ConfirmedPassword(fmt.Sprintf("password for %s (%s)", destItem.Key, destItem.User))
				if err != nil {
					return PrepareRestoreDestinationResult{}, err
				}
				prompt.LogStep(fmt.Sprintf("Ensuring login %q…", destItem.User))
				if err := docker.EnsureDatabaseLogin(image, parentDB, docker.EnsureLoginOpts{
					User: destItem.User, Password: password, Database: destItem.Database, ConnectDatabase: parentLogin,
				}); err != nil {
					return PrepareRestoreDestinationResult{}, err
				}
				if cfg.RememberPassword && session != nil {
					if err := metadata.SetDBPassword(session, childKey, password); err != nil {
						return PrepareRestoreDestinationResult{}, err
					}
				}
				prompt.LogSuccess(fmt.Sprintf("Login %q ready", destItem.User))
				return PrepareRestoreDestinationResult{
					DestDB:       docker.ResolvedDB{DatabaseItem: destItem, Password: password},
					IntoExisting: false,
				}, nil
			}
		}

		item := destItem
		item.User = parentDB.User
		return PrepareRestoreDestinationResult{
			DestDB:       docker.ResolvedDB{DatabaseItem: item, Password: parentDB.Password},
			IntoExisting: true,
		}, nil
	}

	destDB, err := resolveConnectedDB(cfg, session, destItem, "destination", true)
	if err != nil {
		return PrepareRestoreDestinationResult{}, err
	}
	created, err := ensureDestDatabase(cfg, destDB, destItem.Key, yes)
	if err != nil {
		return PrepareRestoreDestinationResult{}, err
	}

	confirmed, err := prompt.ConfirmOrYes(confirmMessage, yes, false)
	if err != nil {
		return PrepareRestoreDestinationResult{}, err
	}
	if !confirmed {
		return PrepareRestoreDestinationResult{Cancelled: true}, nil
	}

	return PrepareRestoreDestinationResult{
		DestDB:       destDB,
		IntoExisting: !created,
	}, nil
}
