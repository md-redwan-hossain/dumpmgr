package cli

import (
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/app"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
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
			fmt.Println("dumpmgr vault status")
			store, err := vault.Open(path)
			if err != nil {
				return err
			}
			defer store.Close()
			st, err := store.Status()
			if err != nil {
				return err
			}
			fmt.Printf("path:          %s\n", st.DBPath)
			fmt.Printf("schema:        v%d\n", st.SchemaVersion)
			fmt.Printf("master:        %v\n", st.HasMaster)
			fmt.Printf("encId:         %s\n", st.EncID)
			fmt.Printf("secrets:       %d\n", st.SecretCount)
			fmt.Printf("dumps indexed: %d\n", st.DumpCount)
			fmt.Printf("audit entries: %d\n", st.AuditCount)
			fmt.Printf("restores:      %d\n", st.RestoreCount)
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
			fmt.Println("dumpmgr audit list")
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
				fmt.Println("No audit entries.")
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
				fmt.Println("No indexed dumps. Run `dumpmgr dump-registry scan` to index existing files.")
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
				fmt.Printf("Dump not indexed: %s\n", args[0])
				return nil
			}
			fmt.Printf("path:      %s\n", rec.RelativePath)
			fmt.Printf("item:      %s\n", rec.ItemKey)
			fmt.Printf("sha256:    %s\n", rec.SHA256)
			fmt.Printf("size:      %d bytes\n", rec.SizeBytes)
			fmt.Printf("encrypted: %v\n", rec.Encrypted)
			fmt.Printf("encId:     %s\n", rec.EncID)
			fmt.Printf("created:   %s\n", rec.CreatedAt.UTC().Format(time.RFC3339))
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
			full := fmt.Sprintf("%s/%s", abs, args[0])
			hash, size, err := vault.SHA256File(full)
			if err != nil {
				return err
			}
			if hash != rec.SHA256 || size != rec.SizeBytes {
				_ = store.RecordAudit(vault.ActionDumpVerify, vault.StatusFailure, args[0], "", fmt.Sprintf("want=%s got=%s", rec.SHA256, hash), "checksum mismatch")
				return fmt.Errorf("checksum mismatch for %s", args[0])
			}
			_ = store.RecordAudit(vault.ActionDumpVerify, vault.StatusSuccess, args[0], "", "checksum ok", "")
			fmt.Printf("✓ %s checksum OK (%s)\n", args[0], hash)
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
			fmt.Printf("✓ Indexed %d dump file(s)\n", n)
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
				fmt.Println("No restore history.")
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
		fmt.Printf("No rotation history for %q.\n", key)
		return nil
	}
	for _, r := range rows {
		fmt.Printf("%s  %s  %s\n", r.RotatedAt.UTC().Format(time.RFC3339), r.Action, r.SecretKey)
	}
	return nil
}

func printSecretList(session *metadata.Session) error {
	infos, err := session.Store.ListSecrets()
	if err != nil {
		return err
	}
	if len(infos) == 0 {
		fmt.Println("No saved DB passwords.")
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
