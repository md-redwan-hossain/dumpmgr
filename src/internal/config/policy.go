package config

import "fmt"

// ValidateEncryptedDumpPolicy returns an error when encrypted dumps are enabled
// without rememberPassword (master-derived AES key required).
func ValidateEncryptedDumpPolicy(cfg *Config) error {
	if cfg.EncryptedDump && !cfg.RememberPassword {
		return fmt.Errorf("encryptedDump requires rememberPassword: true (encrypted dumps need the master-derived AES key)")
	}
	return nil
}

// FindDatabaseItem returns a flat config item by key, or nil if unknown.
func FindDatabaseItem(cfg *Config, key string) *DatabaseItem {
	for _, item := range ConfigItems(cfg) {
		if item.Key == key {
			copy := item
			return &copy
		}
	}
	return nil
}

// FindRestoreDestination returns a restore-tree item by key, or nil if unknown/readonly.
func FindRestoreDestination(cfg *Config, key string) *DatabaseItem {
	for _, opt := range ConfigRestoreTreeItems(cfg) {
		if opt.Key == key {
			if opt.Disabled {
				return nil
			}
			copy := opt.DatabaseItem
			return &copy
		}
	}
	return nil
}
