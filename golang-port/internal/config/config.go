package config

import (
	"fmt"
	"strings"
)

const (
	DefaultImage     = "postgres:18"
	DefaultConfigPath = "config.jsonc"
)

type ChildDatabase struct {
	User     string `json:"user,omitempty"`
	Database string `json:"database"`
}

type DatabaseEntry struct {
	Host     string                    `json:"host"`
	Port     int                       `json:"port"`
	User     string                    `json:"user"`
	Database string                    `json:"database"`
	Readonly bool                      `json:"readonly"`
	Items    map[string]ChildDatabase  `json:"items,omitempty"`
}

type S3Options struct {
	Endpoint                string `json:"endpoint"`
	AccessKey               string `json:"accessKey"`
	BucketName              string `json:"bucketName"`
	CreateBucketIfNotExists bool   `json:"createBucketIfNotExists"`
	UseHTTPS                bool   `json:"useHttps"`
	Region                  string `json:"region,omitempty"`
	ForcePathStyle          bool   `json:"forcePathStyle"`
}

type AutonomousSchedule struct {
	Cron       string   `json:"cron"`
	Items      []string `json:"items,omitempty"`
	UploadToS3 bool     `json:"uploadToS3"`
}

type AutonomousOptions struct {
	Schedules []AutonomousSchedule `json:"schedules"`
}

type Config struct {
	RememberPassword bool                       `json:"rememberPassword"`
	EncryptedDump    bool                       `json:"encryptedDump"`
	DumpDirectory    string                     `json:"dumpDirectory"`
	Image            string                     `json:"image,omitempty"`
	S3Options        *S3Options                 `json:"s3Options,omitempty"`
	Autonomous       *AutonomousOptions         `json:"autonomous,omitempty"`
	Items            map[string]DatabaseEntry   `json:"items"`
}

type DatabaseItem struct {
	Key       string
	Host      string
	Port      int
	User      string
	Database  string
	Nested    bool
	ParentKey string
}

type TreeDatabaseOption struct {
	DatabaseItem
	Depth    int
	Disabled bool
}

func ApplyDefaults(cfg *Config) {
	if cfg.DumpDirectory == "" {
		cfg.DumpDirectory = "."
	}
	if cfg.Items == nil {
		cfg.Items = map[string]DatabaseEntry{}
	}
}

func NeedsMaster(cfg *Config) bool {
	return cfg.RememberPassword || cfg.EncryptedDump || cfg.S3Options != nil
}

func ConfigImage(cfg *Config) string {
	if cfg.Image != "" {
		return cfg.Image
	}
	return DefaultImage
}

func ConfigItems(cfg *Config) []DatabaseItem {
	entries := cfg.Items
	if entries == nil {
		entries = map[string]DatabaseEntry{}
	}
	var out []DatabaseItem
	for key, entry := range entries {
		out = append(out, DatabaseItem{
			Key:      key,
			Host:     entry.Host,
			Port:     entry.Port,
			User:     entry.User,
			Database: entry.Database,
			Nested:   false,
		})
		if entry.Items != nil {
			for childKey, child := range entry.Items {
				user := child.User
				if user == "" {
					user = entry.User
				}
				out = append(out, DatabaseItem{
					Key:       fmt.Sprintf("%s:%s", key, childKey),
					Host:      entry.Host,
					Port:      entry.Port,
					User:      user,
					Database:  child.Database,
					Nested:    true,
					ParentKey: key,
				})
			}
		}
	}
	return out
}

func ConfigRestoreTreeItems(cfg *Config) []TreeDatabaseOption {
	entries := cfg.Items
	if entries == nil {
		entries = map[string]DatabaseEntry{}
	}
	var out []TreeDatabaseOption
	for key, entry := range entries {
		children := entry.Items
		hasChildren := len(children) > 0
		if entry.Readonly && !hasChildren {
			continue
		}
		out = append(out, TreeDatabaseOption{
			DatabaseItem: DatabaseItem{
				Key:      key,
				Host:     entry.Host,
				Port:     entry.Port,
				User:     entry.User,
				Database: entry.Database,
				Nested:   false,
			},
			Depth:    0,
			Disabled: entry.Readonly,
		})
		for childKey, child := range children {
			user := child.User
			if user == "" {
				user = entry.User
			}
			out = append(out, TreeDatabaseOption{
				DatabaseItem: DatabaseItem{
					Key:       fmt.Sprintf("%s:%s", key, childKey),
					Host:      entry.Host,
					Port:      entry.Port,
					User:      user,
					Database:  child.Database,
					Nested:    true,
					ParentKey: key,
				},
				Depth: 1,
			})
		}
	}
	return out
}

func ConfigItemCount(cfg *Config) int {
	return len(ConfigItems(cfg))
}

func GetParentItem(cfg *Config, parentKey string) *DatabaseItem {
	entry, ok := cfg.Items[parentKey]
	if !ok {
		return nil
	}
	return &DatabaseItem{
		Key:      parentKey,
		Host:     entry.Host,
		Port:     entry.Port,
		User:     entry.User,
		Database: entry.Database,
		Nested:   false,
	}
}

func DBKey(itemKey string) string {
	return "postgres:" + itemKey
}

func DefaultConfigScaffold(withFakeData bool) Config {
	if !withFakeData {
		return Config{
			RememberPassword: true,
			EncryptedDump:    false,
			DumpDirectory:    ".",
			Image:            DefaultImage,
			Items:            map[string]DatabaseEntry{},
		}
	}
	return Config{
		RememberPassword: true,
		EncryptedDump:    false,
		DumpDirectory:    ".",
		Image:            DefaultImage,
		S3Options: &S3Options{
			Endpoint:                "http://127.0.0.1:9000",
			AccessKey:               "minioadmin",
			BucketName:              "dumpmgr-demo",
			CreateBucketIfNotExists: false,
			UseHTTPS:                false,
			Region:                  "us-east-1",
			ForcePathStyle:          true,
		},
		Items: map[string]DatabaseEntry{
			"prod": {
				Host:     "127.0.0.1",
				Port:     5432,
				User:     "db_user",
				Database: "app_db",
				Readonly: false,
			},
			"local_dev": {
				Host:     "localhost",
				Port:     5433,
				User:     "db_user",
				Database: "app_db",
				Readonly: false,
				Items: map[string]ChildDatabase{
					"dump": {Database: "app_db_dump"},
				},
			},
		},
	}
}

func ValidateConfig(cfg *Config) []string {
	ApplyDefaults(cfg)
	var issues []string
	if cfg.PortOutOfRange() {
		issues = append(issues, "invalid port in items")
	}
	for key, entry := range cfg.Items {
		if entry.Host == "" {
			issues = append(issues, fmt.Sprintf("items.%s.host: required", key))
		}
		if entry.Port < 1 || entry.Port > 65535 {
			issues = append(issues, fmt.Sprintf("items.%s.port: must be between 1 and 65535", key))
		}
		if entry.User == "" {
			issues = append(issues, fmt.Sprintf("items.%s.user: required", key))
		}
		if entry.Database == "" {
			issues = append(issues, fmt.Sprintf("items.%s.database: required", key))
		}
		for childKey, child := range entry.Items {
			if child.Database == "" {
				issues = append(issues, fmt.Sprintf("items.%s.items.%s.database: required", key, childKey))
			}
		}
	}
	if cfg.S3Options != nil {
		s3 := cfg.S3Options
		if s3.Endpoint == "" {
			issues = append(issues, "s3Options.endpoint: required")
		}
		if s3.AccessKey == "" {
			issues = append(issues, "s3Options.accessKey: required")
		}
		if s3.BucketName == "" {
			issues = append(issues, "s3Options.bucketName: required")
		}
	}
	if cfg.Autonomous != nil && len(cfg.Autonomous.Schedules) == 0 {
		issues = append(issues, "autonomous.schedules: must contain at least one entry")
	}
	return issues
}

func (c *Config) PortOutOfRange() bool {
	for _, entry := range c.Items {
		if entry.Port < 1 || entry.Port > 65535 {
			return true
		}
	}
	return false
}

type ValidateResult struct {
	OK       bool
	Config   *Config
	Report   []string
	Warnings []string
	Issues   []string
}

func BuildValidateReport(cfg *Config) ValidateResult {
	image := ConfigImage(cfg)
	entries := cfg.Items
	if entries == nil {
		entries = map[string]DatabaseEntry{}
	}
	nestedCount := 0
	for _, e := range entries {
		nestedCount += len(e.Items)
	}
	totalItems := len(entries) + nestedCount

	s3Line := "disabled"
	if cfg.S3Options != nil {
		s3Line = fmt.Sprintf("%s/%s", cfg.S3Options.Endpoint, cfg.S3Options.BucketName)
	}
	autonomousLine := "disabled"
	if cfg.Autonomous != nil {
		autonomousLine = fmt.Sprintf("%d schedule(s)", len(cfg.Autonomous.Schedules))
	}

	report := []string{
		fmt.Sprintf("rememberPassword: %v", cfg.RememberPassword),
		fmt.Sprintf("encryptedDump: %v", cfg.EncryptedDump),
		fmt.Sprintf("dumpDirectory: %s", cfg.DumpDirectory),
		fmt.Sprintf("s3Options: %s", s3Line),
		fmt.Sprintf("autonomous: %s", autonomousLine),
		"",
		fmt.Sprintf("image=%s  parents=%d  nested=%d", image, len(entries), nestedCount),
	}
	var warnings []string
	if len(entries) == 0 {
		warnings = append(warnings, "no database items configured")
	}
	if strings.Contains(strings.ToLower(image), "alpine") {
		warnings = append(warnings, fmt.Sprintf(`image contains "alpine" (%s)`, image))
	}
	for key, e := range entries {
		ro := ""
		if e.Readonly {
			ro = "  readonly"
		}
		report = append(report, fmt.Sprintf("  %s → %s:%d  %s / %s%s", key, e.Host, e.Port, e.User, e.Database, ro))
		for childKey, child := range e.Items {
			user := child.User
			if user == "" {
				user = e.User
			}
			report = append(report, fmt.Sprintf("    %s:%s → %s:%d  %s / %s", key, childKey, e.Host, e.Port, user, child.Database))
		}
	}
	if totalItems == 0 {
		warnings = append(warnings, "no database items configured")
	}
	return ValidateResult{OK: true, Config: cfg, Report: report, Warnings: warnings}
}
