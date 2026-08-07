package prompt

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/s3"
	"golang.org/x/term"
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
	fmt.Println("Aborted.")
	os.Exit(0)
}

func SelectMode(cfg *config.Config) (Mode, error) {
	options := []huh.Option[Mode]{
		huh.NewOption("Take dump — Write dump file only", ModeDump),
		huh.NewOption("Restore from dump — Pick a dump file → destination", ModeRestore),
		huh.NewOption("Take dump and restore — Copy source → destination", ModeDumpRestore),
	}
	if config.NeedsMaster(cfg) {
		options = append(options, huh.NewOption("Change master password — Rotate master + re-encrypt secrets", ModeChangeMaster))
	}
	if cfg.S3Options != nil {
		options = append(options,
			huh.NewOption("Upload dump to S3 — Copy a local dump to the configured bucket", ModeS3Upload),
			huh.NewOption("Download dump from S3 — Browse objects and download one locally", ModeS3Download),
		)
	}
	options = append(options, huh.NewOption("Exit", ModeExit))

	var choice Mode
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[Mode]().
			Title("What do you want to do?").
			Options(options...).
			Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return choice, nil
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
	options := make([]huh.Option[string], len(list))
	lookup := make(map[string]config.DatabaseItem)
	for i, db := range list {
		options[i] = huh.NewOption(fmt.Sprintf("%s — %s", db.Key, itemHint(db)), db.Key)
		lookup[db.Key] = db
	}
	var choice string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title(message).Options(options...).Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return lookup[choice], nil
}

func SelectDatabaseTree(cfg *config.Config, message, exclude string) (config.DatabaseItem, error) {
	tree := config.ConfigRestoreTreeItems(cfg)
	var filtered []config.TreeDatabaseOption
	for _, item := range tree {
		if item.Key != exclude {
			filtered = append(filtered, item)
		}
	}
	if len(filtered) == 0 {
		return config.DatabaseItem{}, fmt.Errorf("no databases available to select")
	}
	options := make([]huh.Option[string], 0, len(filtered))
	lookup := make(map[string]config.TreeDatabaseOption)
	for _, db := range filtered {
		leaf := db.Key
		if db.Nested {
			parts := strings.Split(db.Key, ":")
			leaf = "  └ " + parts[len(parts)-1]
		}
		label := fmt.Sprintf("%s — %s", leaf, itemHint(db.DatabaseItem))
		if db.Disabled {
			label += " (readonly)"
		}
		options = append(options, huh.NewOption(label, db.Key))
		lookup[db.Key] = db
	}
	var choice string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title(message).Options(options...).Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	selected := lookup[choice]
	if selected.Disabled {
		return config.DatabaseItem{}, fmt.Errorf("%q is readonly and cannot be a restore destination", selected.Key)
	}
	return selected.DatabaseItem, nil
}

func Password(message string) (string, error) {
	labeled := message
	if !strings.HasPrefix(message, "Enter ") {
		labeled = "Enter " + message
	}
	fmt.Printf("%s: ", labeled)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", err
	}
	pw := string(b)
	if pw == "" {
		fmt.Println("Password is required.")
		os.Exit(1)
	}
	return pw, nil
}

func ConfirmOrYes(message string, yes bool, initialValue bool) (bool, error) {
	if yes {
		return true, nil
	}
	var result bool
	if initialValue {
		result = true
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title(message).Value(&result).Affirmative("Yes").Negative("No"),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return result, nil
}

func SelectNestedRestoreAction(message string, childExists bool) (NestedRestoreAction, error) {
	var choice NestedRestoreAction
	var options []huh.Option[NestedRestoreAction]
	if childExists {
		options = []huh.Option[NestedRestoreAction]{
			huh.NewOption("Yes — Restore into existing database", NestedYes),
			huh.NewOption("Drop database and restore — DROP → CREATE → restore", NestedDrop),
			huh.NewOption("No", NestedNo),
		}
	} else {
		options = []huh.Option[NestedRestoreAction]{
			huh.NewOption("Create database and restore — CREATE → restore", NestedCreate),
			huh.NewOption("No", NestedNo),
		}
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[NestedRestoreAction]().Title(message).Options(options...).Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return choice, nil
}

func SelectReplaceExistingObjects(yes bool) (bool, error) {
	if yes {
		return true, nil
	}
	var choice bool
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[bool]().
			Title("Existing objects in destination?").
			Options(
				huh.NewOption("Replace existing objects — pg_restore --clean --if-exists", true),
				huh.NewOption("Keep existing objects — May fail on name collisions", false),
			).
			Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return choice, nil
}

func SelectNestedCreatePassword(hasSaved bool) (NestedCreatePasswordSource, error) {
	var choice NestedCreatePasswordSource
	options := []huh.Option[NestedCreatePasswordSource]{
		huh.NewOption("Use password from parent — Restore with parent user credentials", PasswordParent),
	}
	if hasSaved {
		options = append(options, huh.NewOption("Use saved password — Child user + password from vault", PasswordSaved))
	}
	options = append(options, huh.NewOption("Create new password — Set password for child user, then restore", PasswordNew))
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[NestedCreatePasswordSource]().Title("Password for new database?").Options(options...).Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return choice, nil
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
		} else {
			fmt.Printf("✗ %v\n", err)
		}
		var action string
		form := huh.NewForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title(fmt.Sprintf("Connection failed for %s. What next?", label)).
				Options(
					huh.NewOption("Retry", "retry"),
					huh.NewOption("Change password and retry", "change"),
					huh.NewOption("Abort", "abort"),
				).
				Value(&action),
		))
		if err := form.Run(); err != nil || action == "abort" {
			OnCancel()
		}
		if action == "change" {
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
		var options []huh.Option[string]
		if cwd != root {
			options = append(options, huh.NewOption(".. — Parent folder", ".."))
		}
		for _, e := range entries {
			if e.Kind == dumps.EntryDir {
				options = append(options, huh.NewOption(e.Name+"/ — Folder", "dir:"+e.Name))
			} else {
				options = append(options, huh.NewOption(e.Name, "file:"+e.Name))
			}
		}
		if len(options) == 0 {
			return "", fmt.Errorf("no dump files or folders under %s", root)
		}
		var choice string
		form := huh.NewForm(huh.NewGroup(
			huh.NewSelect[string]().Title(fmt.Sprintf("Browse dumps (%s)", rel)).Options(options...).Value(&choice),
		))
		if err := form.Run(); err != nil {
			OnCancel()
		}
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
	options := make([]huh.Option[string], len(objects))
	for i, obj := range objects {
		options[i] = huh.NewOption(fmt.Sprintf("%s — %s", obj.Key, s3.FormatObject(obj)), obj.Key)
	}
	var choice string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title("Select an S3 dump object").Options(options...).Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return choice, nil
}

func SelectInitChoice() (string, error) {
	var choice string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Run config init to create config?").
			Options(
				huh.NewOption("Init with fake data", "fake"),
				huh.NewOption("Init with empty items", "empty"),
				huh.NewOption("Abort", "abort"),
			).
			Value(&choice),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return choice, nil
}

func SelectMasterAction() (string, error) {
	var action string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Existing master password found in metadata").
			Options(
				huh.NewOption("Change master password", "change"),
				huh.NewOption("Continue with existing master password", "continue"),
			).
			Value(&action),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return action, nil
}

func SelectEncryptedDumpAction() (string, error) {
	var action string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("What should happen to existing dumps?").
			Options(
				huh.NewOption("Re-encrypt dumps", "reencrypt"),
				huh.NewOption("Delete matching encrypted dumps", "delete"),
			).
			Value(&action),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return action, nil
}

func ConfirmOverwrite(path string) (bool, error) {
	var ok bool
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title(fmt.Sprintf("%s already exists. Overwrite?", path)).Value(&ok),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return ok, nil
}

func ConfirmWipeSecret(key string) (bool, error) {
	var ok bool
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title(fmt.Sprintf(`Remove saved password for "%s"?`, key)).Value(&ok),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return ok, nil
}

func ConfirmInitOverwrite(path string) (bool, error) {
	var ok bool
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title(fmt.Sprintf("%s already exists. Overwrite?", path)).Value(&ok),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return ok, nil
}

func ConfirmFakeData() (bool, error) {
	var ok bool
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title("Populate with dummy data?").Value(&ok),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return ok, nil
}

func TryAgain() (bool, error) {
	var ok bool
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title("Try again?").Value(&ok),
	))
	if err := form.Run(); err != nil {
		OnCancel()
	}
	return ok, nil
}
