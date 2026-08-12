package prompt

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	clack "github.com/orochaa/go-clack/prompts"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/s3"
)

type Mode string

const (
	ModeDumpRestore  Mode = "dump-restore"
	ModeDump         Mode = "dump"
	ModeRestore      Mode = "restore"
	ModeChangeMaster Mode = "change-master"
	ModeS3Upload     Mode = "s3-upload"
	ModeS3Download   Mode = "s3-download"
	ModeExit         Mode = "exit"
)

type NestedRestoreAction string

const (
	NestedYes    NestedRestoreAction = "yes"
	NestedNo     NestedRestoreAction = "no"
	NestedDrop   NestedRestoreAction = "drop"
	NestedCreate NestedRestoreAction = "create"
)

type NestedCreatePasswordSource string

const (
	PasswordParent NestedCreatePasswordSource = "parent"
	PasswordSaved  NestedCreatePasswordSource = "saved"
	PasswordNew    NestedCreatePasswordSource = "new"
)

func OnCancel() {
	clack.Cancel("Aborted.")
	os.Exit(0)
}

func exitOnCancel[T any](v T, err error) T {
	if err != nil {
		OnCancel()
	}
	return v
}

func runSelect[T comparable](message string, options []*clack.SelectOption[T]) T {
	return exitOnCancel(clack.Select(clack.SelectParams[T]{
		Message: message,
		Options: options,
	}))
}

func runConfirm(message string, initial bool) bool {
	return exitOnCancel(clack.Confirm(clack.ConfirmParams{
		Message:      message,
		InitialValue: initial,
	}))
}

func SelectMode(cfg *config.Config) (Mode, error) {
	options := []*clack.SelectOption[Mode]{
		{Label: "Take dump", Value: ModeDump, Hint: "Write dump file only"},
		{Label: "Restore from dump", Value: ModeRestore, Hint: "Pick a dump file → destination"},
		{Label: "Take dump and restore", Value: ModeDumpRestore, Hint: "Copy source → destination"},
	}
	if config.NeedsMaster(cfg) {
		options = append(options, &clack.SelectOption[Mode]{
			Label: "Change master password",
			Value: ModeChangeMaster,
			Hint:  "Rotate master + re-encrypt secrets",
		})
	}
	if cfg.S3Options != nil {
		options = append(options,
			&clack.SelectOption[Mode]{Label: "Upload dump to S3", Value: ModeS3Upload, Hint: "Copy a local dump to the configured bucket"},
			&clack.SelectOption[Mode]{Label: "Download dump from S3", Value: ModeS3Download, Hint: "Browse objects and download one locally"},
		)
	}
	options = append(options, &clack.SelectOption[Mode]{Label: "Exit", Value: ModeExit})
	return runSelect("What do you want to do?", options), nil
}

func RequireItems(cfg *config.Config, minItems int) error {
	if config.ConfigItemCount(cfg) < minItems {
		return fmt.Errorf("need at least %d database item(s). Edit config.jsonc", minItems)
	}
	return nil
}

func itemHint(db config.DatabaseItem) string {
	return fmt.Sprintf("%s@%s:%d/%s", db.User, db.Host, db.Port, db.Database)
}

func SelectDatabaseItem(items []config.DatabaseItem, message string, exclude string) (config.DatabaseItem, error) {
	var list []config.DatabaseItem
	for _, item := range items {
		if item.Key != exclude {
			list = append(list, item)
		}
	}
	if len(list) == 0 {
		return config.DatabaseItem{}, fmt.Errorf("no databases available to select")
	}
	options := make([]*clack.SelectOption[string], len(list))
	lookup := make(map[string]config.DatabaseItem)
	for i, db := range list {
		options[i] = &clack.SelectOption[string]{
			Label: fmt.Sprintf("%s — %s", db.Key, itemHint(db)),
			Value: db.Key,
		}
		lookup[db.Key] = db
	}
	key := runSelect(message, options)
	return lookup[key], nil
}

func SelectDatabaseTree(cfg *config.Config, message, exclude string) (config.DatabaseItem, error) {
	tree := config.ConfigRestoreTreeItems(cfg)
	var filtered []config.TreeDatabaseOption
	for _, item := range tree {
		if item.Key == exclude || item.Disabled {
			continue
		}
		filtered = append(filtered, item)
	}
	if len(filtered) == 0 {
		return config.DatabaseItem{}, fmt.Errorf("no databases available to select")
	}
	options := make([]*clack.SelectOption[string], 0, len(filtered))
	lookup := make(map[string]config.TreeDatabaseOption)
	for _, db := range filtered {
		leaf := db.Key
		if db.Nested {
			parts := strings.Split(db.Key, ":")
			leaf = "  └ " + parts[len(parts)-1]
		}
		options = append(options, &clack.SelectOption[string]{
			Label: fmt.Sprintf("%s — %s", leaf, itemHint(db.DatabaseItem)),
			Value: db.Key,
		})
		lookup[db.Key] = db
	}
	key := runSelect(message, options)
	return lookup[key].DatabaseItem, nil
}

func ResolveDatabaseItem(items []config.DatabaseItem, key, message, exclude string) (config.DatabaseItem, error) {
	if key != "" {
		if key == exclude {
			return config.DatabaseItem{}, fmt.Errorf(`cannot use %q as source/destination`, key)
		}
		for _, item := range items {
			if item.Key == key {
				return item, nil
			}
		}
		return config.DatabaseItem{}, fmt.Errorf(`unknown database %q. Check config.jsonc items`, key)
	}
	return SelectDatabaseItem(items, message, exclude)
}

func ResolveDatabaseTree(cfg *config.Config, key, message, exclude string) (config.DatabaseItem, error) {
	if key != "" {
		if key == exclude {
			return config.DatabaseItem{}, fmt.Errorf(`cannot use %q as source/destination`, key)
		}
		for _, opt := range config.ConfigRestoreTreeItems(cfg) {
			if opt.Key != key {
				continue
			}
			if opt.Disabled {
				return config.DatabaseItem{}, fmt.Errorf("%q is readonly and cannot be a restore destination", key)
			}
			return opt.DatabaseItem, nil
		}
		return config.DatabaseItem{}, fmt.Errorf(`unknown database %q. Check config.jsonc items`, key)
	}
	return SelectDatabaseTree(cfg, message, exclude)
}

func Password(message string) (string, error) {
	labeled := message
	if !strings.HasPrefix(message, "Enter ") {
		labeled = "Enter " + message
	}
	pw := exitOnCancel(clack.Password(clack.PasswordParams{
		Message:  labeled,
		Required: true,
	}))
	return pw, nil
}

func ConfirmOrYes(message string, yes bool, initialValue bool) (bool, error) {
	if yes {
		return true, nil
	}
	return runConfirm(message, initialValue), nil
}

func SelectNestedRestoreAction(message string, childExists bool) (NestedRestoreAction, error) {
	var options []*clack.SelectOption[NestedRestoreAction]
	if childExists {
		options = []*clack.SelectOption[NestedRestoreAction]{
			{Label: "Yes — Restore into existing database", Value: NestedYes},
			{Label: "Drop database and restore — DROP → CREATE → restore", Value: NestedDrop},
			{Label: "No", Value: NestedNo},
		}
	} else {
		options = []*clack.SelectOption[NestedRestoreAction]{
			{Label: "Create database and restore — CREATE → restore", Value: NestedCreate},
			{Label: "No", Value: NestedNo},
		}
	}
	return runSelect(message, options), nil
}

func SelectReplaceExistingObjects(yes bool) (bool, error) {
	if yes {
		return true, nil
	}
	type choice string
	const (
		replace choice = "replace"
		keep    choice = "keep"
	)
	selected := runSelect("Existing objects in destination?", []*clack.SelectOption[choice]{
		{Label: "Replace existing objects — pg_restore --clean --if-exists", Value: replace},
		{Label: "Keep existing objects — May fail on name collisions", Value: keep},
	})
	return selected == replace, nil
}

func SelectNestedCreatePassword(hasSaved bool) (NestedCreatePasswordSource, error) {
	options := []*clack.SelectOption[NestedCreatePasswordSource]{
		{Label: "Use password from parent — Restore with parent user credentials", Value: PasswordParent},
	}
	if hasSaved {
		options = append(options, &clack.SelectOption[NestedCreatePasswordSource]{
			Label: "Use saved password — Child user + password from vault",
			Value: PasswordSaved,
		})
	}
	options = append(options, &clack.SelectOption[NestedCreatePasswordSource]{
		Label: "Create new password — Set password for child user, then restore",
		Value: PasswordNew,
	})
	return runSelect("Password for new database?", options), nil
}

func ConfirmedPassword(label string) (string, error) {
	password, err := Password(label)
	if err != nil {
		return "", err
	}
	confirm, err := Password("confirm " + label)
	if err != nil {
		return "", err
	}
	if password != confirm {
		return "", fmt.Errorf("passwords do not match")
	}
	return password, nil
}

func ResolveDBPassword(session *metadata.Session, remember bool, item config.DatabaseItem) (string, error) {
	key := config.DBKey(item.Key)
	if remember && session != nil && session.AESKey != nil {
		existing, err := metadata.GetDBPassword(session, key)
		if err != nil {
			return "", err
		}
		if existing != "" {
			return existing, nil
		}
	}
	pw, err := Password(fmt.Sprintf("password for %s (%s@%s)", item.Key, item.User, item.Host))
	if err != nil {
		return "", err
	}
	if remember && session != nil {
		if err := metadata.SetDBPassword(session, key, pw); err != nil {
			return "", err
		}
	}
	return pw, nil
}

func ConnectWithRetry(label string, getPassword func() (string, error), setPassword func(string) error, connect func(string) error) (string, error) {
	password, err := getPassword()
	if err != nil {
		return "", err
	}
	for {
		if err := connect(password); err == nil {
			return password, nil
		}
		LogError(err.Error())
		type action string
		const (
			retry  action = "retry"
			change action = "change"
			abort  action = "abort"
		)
		selected := runSelect(fmt.Sprintf("Connection failed for %s. What next?", label), []*clack.SelectOption[action]{
			{Label: "Retry", Value: retry},
			{Label: "Change password and retry", Value: change},
			{Label: "Abort", Value: abort},
		})
		if selected == abort {
			OnCancel()
		}
		if selected == change {
			password, err = Password(fmt.Sprintf("new password for %s", label))
			if err != nil {
				return "", err
			}
			if err := setPassword(password); err != nil {
				return "", err
			}
		}
	}
}

func BrowseDumpFile(rootDir string, encryptedOnly bool) (string, error) {
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return "", err
	}
	root, err := filepath.Abs(rootDir)
	if err != nil {
		return "", err
	}
	cwd := root
	for {
		rel, _ := filepath.Rel(root, cwd)
		if rel == "." {
			rel = "."
		}
		entries, err := dumps.ListBrowserEntries(cwd, encryptedOnly)
		if err != nil {
			return "", err
		}
		var options []*clack.SelectOption[string]
		if cwd != root {
			options = append(options, &clack.SelectOption[string]{Label: ".. — Parent folder", Value: ".."})
		}
		for _, e := range entries {
			if e.Kind == dumps.EntryDir {
				options = append(options, &clack.SelectOption[string]{Label: e.Name + "/ — Folder", Value: "dir:" + e.Name})
			} else {
				options = append(options, &clack.SelectOption[string]{Label: e.Name, Value: "file:" + e.Name})
			}
		}
		if len(options) == 0 {
			return "", fmt.Errorf("no dump files or folders under %s", root)
		}
		choice := runSelect(fmt.Sprintf("Browse dumps (%s)", rel), options)
		if choice == ".." {
			cwd = filepath.Dir(cwd)
			if !strings.HasPrefix(cwd, root) {
				cwd = root
			}
			continue
		}
		if strings.HasPrefix(choice, "dir:") {
			cwd = filepath.Join(cwd, strings.TrimPrefix(choice, "dir:"))
			continue
		}
		if strings.HasPrefix(choice, "file:") {
			return filepath.Join(cwd, strings.TrimPrefix(choice, "file:")), nil
		}
	}
}

func SelectS3Object(objects []s3.Object) (string, error) {
	if len(objects) == 0 {
		return "", fmt.Errorf("no dump objects found in the S3 bucket")
	}
	options := make([]*clack.SelectOption[string], len(objects))
	for i, obj := range objects {
		options[i] = &clack.SelectOption[string]{
			Label: fmt.Sprintf("%s — %s", obj.Key, s3.FormatObject(obj)),
			Value: obj.Key,
		}
	}
	return runSelect("Select an S3 dump object", options), nil
}

func SelectInitChoice() (string, error) {
	return runSelect("Run config init to create config?", []*clack.SelectOption[string]{
		{Label: "Init with fake data", Value: "fake"},
		{Label: "Init with empty items", Value: "empty"},
		{Label: "Abort", Value: "abort"},
	}), nil
}

func SelectMasterAction() (string, error) {
	return runSelect("Existing master password found in vault", []*clack.SelectOption[string]{
		{Label: "Change master password", Value: "change"},
		{Label: "Continue with existing master password", Value: "continue"},
	}), nil
}

func SelectEncryptedDumpAction() (string, error) {
	return runSelect("What should happen to existing dumps?", []*clack.SelectOption[string]{
		{Label: "Re-encrypt dumps", Value: "reencrypt"},
		{Label: "Delete matching encrypted dumps", Value: "delete"},
	}), nil
}

func ConfirmOverwrite(path string) (bool, error) {
	return runConfirm(fmt.Sprintf("%s already exists. Overwrite?", path), false), nil
}

func ConfirmWipeSecret(key string) (bool, error) {
	return runConfirm(fmt.Sprintf(`Remove saved password for "%s"?`, key), false), nil
}

func ConfirmInitOverwrite(path string) (bool, error) {
	return runConfirm(fmt.Sprintf("%s already exists. Overwrite?", path), false), nil
}

func ConfirmFakeData() (bool, error) {
	return runConfirm("Populate with dummy data?", false), nil
}

func TryAgain() (bool, error) {
	return runConfirm("Try again?", true), nil
}
