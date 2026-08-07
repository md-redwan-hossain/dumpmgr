package cli

import (
	"fmt"
	"os"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/app"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/doctor"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/initcmd"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/prompt"
	"github.com/spf13/cobra"
)

func Execute() error {
	return rootCmd().Execute()
}

func rootCmd() *cobra.Command {
	var configPath string
	var yes bool
	var debug bool

	root := &cobra.Command{
		Use:   "dumpmgr",
		Short: "Dump Manager — dump and restore Postgres databases via Docker",
		Long: `Dump Manager — dump and restore Postgres databases via Docker.

Auxiliary commands:
  doctor              Check Docker / dumps dir / metadata integrity
  s3 upload           Upload a local dump to S3
  s3 download         Browse and download a dump from S3
  secret list         List stored DB password keys (no values)
  secret wipe <key>   Remove a stored DB password by key
  config {init|validate|lint}`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return handleMain(configPath, yes, debug, "")
		},
	}
	root.Flags().StringVarP(&configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	root.Flags().BoolVar(&yes, "yes", false, "Skip confirms; auto-create missing dest DB")
	root.Flags().BoolVar(&debug, "debug", false, "Print docker/DB commands being executed")

	addModeCommands(root, &configPath, &yes, &debug)
	addS3Commands(root, &configPath, &yes)
	addDoctorCommand(root, &configPath)
	addSecretCommands(root, &configPath, &yes)
	addConfigCommands(root, &configPath)

	return root
}

func addModeCommands(root *cobra.Command, configPath *string, yes, debug *bool) {
	modes := []struct {
		name string
		mode app.Mode
		desc string
	}{
		{"dump", app.ModeDump, "Take dump (write dump file only)"},
		{"restore", app.ModeRestore, "Restore from dump"},
		{"dump-restore", app.ModeDumpRestore, "Take dump and restore (copy source → destination)"},
	}
	for _, m := range modes {
		cmd := &cobra.Command{
			Use:   m.name,
			Short: m.desc,
			RunE: func(cmd *cobra.Command, args []string) error {
				return handleMain(*configPath, *yes, *debug, m.mode)
			},
		}
		cmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
		cmd.Flags().BoolVar(yes, "yes", false, "Skip confirms; auto-create missing dest DB")
		cmd.Flags().BoolVar(debug, "debug", false, "Print docker/DB commands being executed")
		root.AddCommand(cmd)
	}
}

func handleMain(configPath string, yes, debug bool, mode app.Mode) error {
	opts := app.Options{
		ConfigPath: configPath,
		Yes:        yes,
		Debug:      debug,
		Mode:       mode,
	}
	if err := app.RunMain(opts); err != nil {
		fmt.Printf("✗ %v\n", err)
		return err
	}
	return nil
}

func addS3Commands(root *cobra.Command, configPath *string, yes *bool) {
	s3Cmd := &cobra.Command{Use: "s3", Short: "Manually upload or download dumps using configured S3"}
	for _, action := range []struct {
		name string
		fn   app.S3Action
		desc string
	}{
		{"upload", app.S3Upload, "Upload a local dump to S3"},
		{"download", app.S3Download, "Browse and download a dump from S3"},
	} {
		a := action
		cmd := &cobra.Command{
			Use:   a.name,
			Short: a.desc,
			RunE: func(cmd *cobra.Command, args []string) error {
				return handleS3(a.fn, *configPath, *yes)
			},
		}
		cmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
		cmd.Flags().BoolVar(yes, "yes", false, "Overwrite an existing local download")
		s3Cmd.AddCommand(cmd)
	}
	root.AddCommand(s3Cmd)
}

func handleS3(action app.S3Action, configPath string, yes bool) error {
	path := config.ResolvePath(configPath)
	fmt.Printf("dumpmgr s3 %s\n", action)
	if !config.Exists(path) {
		fmt.Printf("✗ Config file not found: %s\n", path)
		os.Exit(1)
	}
	cfg, err := config.Load(path)
	if err != nil {
		fmt.Printf("✗ %v\n", err)
		os.Exit(1)
	}
	if err := app.RunS3Action(action, cfg, path, yes); err != nil {
		fmt.Printf("✗ %v\n", err)
		return err
	}
	fmt.Println("done")
	return nil
}

func addDoctorCommand(root *cobra.Command, configPath *string) {
	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "Check Docker daemon, dumps dir permissions, and metadata integrity",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			fmt.Println("dumpmgr doctor")
			if !config.Exists(path) {
				fmt.Printf("✗ Config file not found: %s\n", path)
				fmt.Println("config missing")
				os.Exit(1)
			}
			cfg, err := config.Load(path)
			if err != nil {
				fmt.Printf("✗ %v\n", err)
				fmt.Println("config invalid")
				os.Exit(1)
			}
			report := doctor.Run(cfg, path)
			for _, check := range report.Checks {
				if check.OK {
					fmt.Printf("✓ %s: %s\n", check.Name, check.Message)
				} else {
					fmt.Printf("✗ %s: %s\n", check.Name, check.Message)
					if check.Hint != "" {
						fmt.Printf("  hint: %s\n", check.Hint)
					}
				}
			}
			if report.OK {
				fmt.Println("doctor ok")
				return nil
			}
			fmt.Println("doctor found problems")
			os.Exit(1)
			return nil
		},
	}
	cmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	root.AddCommand(cmd)
}

func addSecretCommands(root *cobra.Command, configPath *string, yes *bool) {
	secretCmd := &cobra.Command{Use: "secret", Short: "List or wipe saved DB passwords"}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List stored DB password keys (values are never shown)",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			fmt.Println("dumpmgr secret list")
			cfg, err := loadConfigOrExit(path, "config missing")
			if err != nil {
				return err
			}
			session, err := app.UnlockForSecretOps(cfg, path)
			if err != nil {
				return err
			}
			if session == nil {
				fmt.Println("nothing to list")
				return nil
			}
			keys := app.SortedSecretKeys(session)
			if len(keys) == 0 {
				fmt.Println("No saved DB passwords.")
			} else {
				for _, k := range keys {
					fmt.Println(k)
				}
			}
			fmt.Printf("%d stored\n", len(keys))
			return nil
		},
	}
	listCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	wipeCmd := &cobra.Command{
		Use:   "wipe [key]",
		Short: "Remove a saved DB password by key (e.g. postgres:prod)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			targetKey := args[0]
			fmt.Printf("dumpmgr secret wipe %s\n", targetKey)
			cfg, err := loadConfigOrExit(path, "config missing")
			if err != nil {
				return err
			}
			session, err := app.UnlockForSecretOps(cfg, path)
			if err != nil {
				return err
			}
			if session == nil {
				fmt.Println("nothing to wipe")
				return nil
			}
			if _, ok := session.Metadata.DBPasswords[targetKey]; !ok {
				fmt.Printf(`⚠ "%s" is not stored.`+"\n", targetKey)
				fmt.Println("no change")
				return nil
			}
			if !*yes {
				ok, err := prompt.ConfirmWipeSecret(targetKey)
				if err != nil {
					return err
				}
				if !ok {
					fmt.Println("⚠ wipe cancelled")
					fmt.Println("no change")
					return nil
				}
			}
			removed, err := metadata.DeleteDBPassword(session, targetKey)
			if err != nil {
				return err
			}
			if removed {
				fmt.Printf(`✓ Removed "%s".`+"\n", targetKey)
				fmt.Println("Encrypted dumps remain unaffected (they use the master key, not per-DB passwords).")
			} else {
				fmt.Printf(`⚠ "%s" was already gone.`+"\n", targetKey)
			}
			fmt.Println("done")
			return nil
		},
	}
	wipeCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	wipeCmd.Flags().BoolVar(yes, "yes", false, "Skip confirmation prompt")

	secretCmd.AddCommand(listCmd, wipeCmd)
	root.AddCommand(secretCmd)
}

func addConfigCommands(root *cobra.Command, configPath *string) {
	configCmd := &cobra.Command{Use: "config", Short: "Manage config.jsonc"}

	initCmd := &cobra.Command{
		Use:   "init",
		Short: "Scaffold config.jsonc and metadata",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Println("dumpmgr config init")
			withFake, _ := cmd.Flags().GetBool("with-fake-data")
			var withFakePtr *bool
			if cmd.Flags().Changed("with-fake-data") {
				withFakePtr = &withFake
			}
			if err := initcmd.Run(initcmd.Options{
				Config:       config.ResolvePath(*configPath),
				WithFakeData: withFakePtr,
			}); err != nil {
				fmt.Printf("✗ %v\n", err)
				return err
			}
			return nil
		},
	}
	initCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	initCmd.Flags().Bool("with-fake-data", false, "Skip prompt; populate sample database items")

	validateCmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate config.jsonc and print a summary report",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			fmt.Println("dumpmgr config validate")
			result := config.ValidateFile(path)
			if !result.OK {
				for _, issue := range result.Issues {
					fmt.Printf("✗ %s\n", issue)
				}
				fmt.Println("config invalid")
				os.Exit(1)
			}
			for _, line := range result.Report {
				if line != "" {
					fmt.Println(line)
				}
			}
			for _, w := range result.Warnings {
				fmt.Printf("⚠ %s\n", w)
			}
			if len(result.Warnings) > 0 {
				fmt.Println("config ok (with warnings)")
			} else {
				fmt.Println("config ok")
			}
			return nil
		},
	}
	validateCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	lintCmd := &cobra.Command{
		Use:   "lint",
		Short: "Format config.jsonc in place (preserves comments)",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			fmt.Println("dumpmgr config lint")
			if err := config.LintFile(path); err != nil {
				fmt.Printf("✗ %v\n", err)
				return err
			}
			fmt.Printf("✓ Formatted %s\n", path)
			fmt.Println("done")
			return nil
		},
	}
	lintCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	configCmd.AddCommand(initCmd, validateCmd, lintCmd)
	root.AddCommand(configCmd)
}

func loadConfigOrExit(path, outro string) (*config.Config, error) {
	if !config.Exists(path) {
		fmt.Printf("✗ Config file not found: %s\n", path)
		fmt.Println(outro)
		os.Exit(1)
	}
	cfg, err := config.Load(path)
	if err != nil {
		fmt.Printf("✗ %v\n", err)
		fmt.Println("config invalid")
		os.Exit(1)
	}
	return cfg, nil
}
