package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"text/tabwriter"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/app"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/prompt"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/vault"
	"github.com/spf13/cobra"
)

func addInspectCommands(root *cobra.Command, configPath *string) {
	addVaultCommands(root, configPath)
	addAuditCommands(root, configPath)
	addDumpRegistryCommands(root, configPath)
	addRestoreHistoryCommands(root, configPath)
}

func addVaultCommands(root *cobra.Command, configPath *string) {
	cmd := &cobra.Command{
		Use:   "vault",
		Short: "Inspect the SQLite vault database",
	}
	status := &cobra.Command{
		Use:   "status",
		Short: "Show vault summary (counts, encId, path)",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			prompt.Intro("dumpmgr vault status")
			store, err := vault.Open(path)
			if err != nil {
				return err
			}
			defer store.Close()
			st, err := store.Status()
			if err != nil {
				return err
			}
			prompt.LogInfo(fmt.Sprintf("path:          %s", st.DBPath))
			prompt.LogInfo(fmt.Sprintf("schema:        v%d", st.SchemaVersion))
			prompt.LogInfo(fmt.Sprintf("master:        %v", st.HasMaster))
			prompt.LogInfo(fmt.Sprintf("encId:         %s", st.EncID))
			prompt.LogInfo(fmt.Sprintf("secrets:       %d", st.SecretCount))
			prompt.LogInfo(fmt.Sprintf("dumps indexed: %d", st.DumpCount))
			prompt.LogInfo(fmt.Sprintf("audit entries: %d", st.AuditCount))
			prompt.LogInfo(fmt.Sprintf("restores:      %d", st.RestoreCount))
			return nil
		},
	}
	status.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	cmd.AddCommand(status)
	root.AddCommand(cmd)
}

func addAuditCommands(root *cobra.Command, configPath *string) {
	var limit int
	var action string
	cmd := &cobra.Command{Use: "audit", Short: "View audit log entries"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List recent audit log entries",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			prompt.Intro("dumpmgr audit list")
			store, err := vault.Open(path)
			if err != nil {
				return err
			}
			defer store.Close()
			entries, err := store.ListAudit(action, limit)
			if err != nil {
				return err
			}
			if len(entries) == 0 {
				prompt.LogInfo("No audit entries.")
				return nil
			}
			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "TIME\tACTION\tSTATUS\tSUBJECT\tDESTINATION")
			for _, e := range entries {
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
					e.OccurredAt.UTC().Format(time.RFC3339), e.Action, e.Status, e.Subject, e.Destination)
			}
			return w.Flush()
		},
	}
	list.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	list.Flags().IntVar(&limit, "limit", 50, "Max entries")
	list.Flags().StringVar(&action, "action", "", "Filter by action")
	cmd.AddCommand(list)
	root.AddCommand(cmd)
}

func addDumpRegistryCommands(root *cobra.Command, configPath *string) {
	var limit int
	var itemKey string
	dumpCmd := &cobra.Command{Use: "dump-registry", Short: "Inspect indexed dump file metadata"}

	list := &cobra.Command{
		Use:   "list",
		Short: "List indexed dumps with SHA-256 checksums",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			store, err := vault.Open(path)
			if err != nil {
				return err
			}
			defer store.Close()
			records, err := store.ListDumps(itemKey, limit)
			if err != nil {
				return err
			}
			if len(records) == 0 {
				prompt.LogInfo("No indexed dumps. Run `dumpmgr dump-registry scan` to index existing files.")
				return nil
			}
			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "PATH\tITEM\tSHA256\tSIZE\tENCRYPTED\tCREATED")
			for _, d := range records {
				fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%v\t%s\n",
					d.RelativePath, d.ItemKey, d.SHA256, d.SizeBytes, d.Encrypted, d.CreatedAt.UTC().Format(time.RFC3339))
			}
			return w.Flush()
		},
	}
	list.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	list.Flags().IntVar(&limit, "limit", 100, "Max entries")
	list.Flags().StringVar(&itemKey, "item", "", "Filter by database item key")

	show := &cobra.Command{
		Use:   "show [relative-path]",
		Short: "Show metadata for one indexed dump",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			store, err := vault.Open(path)
			if err != nil {
				return err
			}
			defer store.Close()
			rec, err := store.GetDumpByPath(args[0])
			if err != nil {
				return err
			}
			if rec == nil {
				prompt.LogWarn(fmt.Sprintf("Dump not indexed: %s", args[0]))
				return nil
			}
			prompt.LogInfo(fmt.Sprintf("path:      %s", rec.RelativePath))
			prompt.LogInfo(fmt.Sprintf("item:      %s", rec.ItemKey))
			prompt.LogInfo(fmt.Sprintf("sha256:    %s", rec.SHA256))
			prompt.LogInfo(fmt.Sprintf("size:      %d bytes", rec.SizeBytes))
			prompt.LogInfo(fmt.Sprintf("encrypted: %v", rec.Encrypted))
			prompt.LogInfo(fmt.Sprintf("encId:     %s", rec.EncID))
			prompt.LogInfo(fmt.Sprintf("created:   %s", rec.CreatedAt.UTC().Format(time.RFC3339)))
			return nil
		},
	}
	show.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	verify := &cobra.Command{
		Use:   "verify [relative-path]",
		Short: "Verify on-disk SHA-256 matches the vault record",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := loadConfigOrExit(config.ResolvePath(*configPath), "config missing")
			if err != nil {
				return err
			}
			store, err := vault.Open(config.ResolvePath(*configPath))
			if err != nil {
				return err
			}
			defer store.Close()
			rec, err := store.GetDumpByPath(args[0])
			if err != nil {
				return err
			}
			if rec == nil {
				return fmt.Errorf("dump not indexed: %s", args[0])
			}
			abs := dumps.ResolveRoot(cfg.DumpDirectory)
			full := filepath.Join(abs, filepath.FromSlash(args[0]))
			hash, size, err := vault.SHA256File(full)
			if err != nil {
				return err
			}
			if hash != rec.SHA256 || size != rec.SizeBytes {
				_ = store.RecordAudit(vault.ActionDumpVerify, vault.StatusFailure, args[0], "", fmt.Sprintf("want=%s got=%s", rec.SHA256, hash), "checksum mismatch")
				return fmt.Errorf("checksum mismatch for %s", args[0])
			}
			_ = store.RecordAudit(vault.ActionDumpVerify, vault.StatusSuccess, args[0], "", "checksum ok", "")
			prompt.LogSuccess(fmt.Sprintf("%s checksum OK (%s)", args[0], hash))
			return nil
		},
	}
	verify.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	scan := &cobra.Command{
		Use:   "scan",
		Short: "Index existing dump files under dumps/ (computes SHA-256)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := loadConfigOrExit(config.ResolvePath(*configPath), "config missing")
			if err != nil {
				return err
			}
			store, err := vault.Open(config.ResolvePath(*configPath))
			if err != nil {
				return err
			}
			defer store.Close()
			root := dumps.ResolveRoot(cfg.DumpDirectory)
			n, err := store.ScanDumpsRoot(root)
			if err != nil {
				return err
			}
			_ = store.RecordAudit(vault.ActionDumpScan, vault.StatusSuccess, root, "", fmt.Sprintf("indexed=%d", n), "")
			prompt.LogSuccess(fmt.Sprintf("Indexed %d dump file(s)", n))
			return nil
		},
	}
	scan.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	dumpCmd.AddCommand(list, show, verify, scan)
	root.AddCommand(dumpCmd)
}

func addRestoreHistoryCommands(root *cobra.Command, configPath *string) {
	var limit int
	var destination string
	cmd := &cobra.Command{Use: "restore-history", Short: "View restore history from the vault"}
	list := &cobra.Command{
		Use:   "list",
		Short: "List recent restore operations",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := vault.Open(config.ResolvePath(*configPath))
			if err != nil {
				return err
			}
			defer store.Close()
			rows, err := store.ListRestoreHistory(destination, limit)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				prompt.LogInfo("No restore history.")
				return nil
			}
			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "TIME\tSTATUS\tDUMP\tDESTINATION\tDURATION_MS\tSHA256")
			for _, r := range rows {
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%s\n",
					r.RestoredAt.UTC().Format(time.RFC3339), r.Status, r.DumpRelativePath, r.DestinationKey, r.DurationMS, r.DumpSHA256)
			}
			return w.Flush()
		},
	}
	list.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	list.Flags().IntVar(&limit, "limit", 50, "Max entries")
	list.Flags().StringVar(&destination, "destination", "", "Filter by destination key")
	cmd.AddCommand(list)
	root.AddCommand(cmd)
}

func printSecretHistory(session *metadata.Session, key string, limit int) error {
	rows, err := session.Store.ListSecretRotations(key, limit)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		prompt.LogInfo(fmt.Sprintf("No rotation history for %q.", key))
		return nil
	}
	for _, r := range rows {
		prompt.LogInfo(fmt.Sprintf("%s  %s  %s", r.RotatedAt.UTC().Format(time.RFC3339), r.Action, r.SecretKey))
	}
	return nil
}

func printSecretList(session *metadata.Session) error {
	infos, err := session.Store.ListSecrets()
	if err != nil {
		return err
	}
	if len(infos) == 0 {
		prompt.LogInfo("No saved DB passwords.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "KEY\tCREATED\tUPDATED\tLAST_USED")
	for _, s := range infos {
		last := "-"
		if s.LastUsedAt != nil {
			last = s.LastUsedAt.UTC().Format(time.RFC3339)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
			s.Key, s.CreatedAt.UTC().Format(time.RFC3339), s.UpdatedAt.UTC().Format(time.RFC3339), last)
	}
	return w.Flush()
}

// ensure app package used
var _ = app.WarnEncryptedDumpConfig
