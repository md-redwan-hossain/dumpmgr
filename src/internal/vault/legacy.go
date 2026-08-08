package vault

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

var legacyMagic = []byte("DBSM")

type legacyMetadata struct {
	MasterPassword *string           `json:"masterPassword,omitempty"`
	KdfSalt        *string           `json:"kdfSalt,omitempty"`
	DBPasswords    map[string]string `json:"dbPasswords"`
	EncID          *string           `json:"encId,omitempty"`
	S3SecretKey    *string           `json:"s3SecretKey,omitempty"`
}

func decodeLegacyBinary(buf []byte) (legacyMetadata, error) {
	if len(buf) < len(legacyMagic)+2 {
		return legacyMetadata{}, fmt.Errorf("invalid legacy metadata (too short)")
	}
	for i := range legacyMagic {
		if buf[i] != legacyMagic[i] {
			return legacyMetadata{}, fmt.Errorf("invalid legacy metadata (bad magic)")
		}
	}
	gr, err := gzip.NewReader(bytes.NewReader(buf[len(legacyMagic)+1:]))
	if err != nil {
		return legacyMetadata{}, err
	}
	defer gr.Close()
	var meta legacyMetadata
	if err := json.NewDecoder(gr).Decode(&meta); err != nil {
		return legacyMetadata{}, err
	}
	if meta.DBPasswords == nil {
		meta.DBPasswords = map[string]string{}
	}
	return meta, nil
}

func loadLegacyMetadata(configPath string) (*legacyMetadata, string, error) {
	dir := filepath.Dir(configPath)
	binaryPath := filepath.Join(dir, "metadata")
	if data, err := os.ReadFile(binaryPath); err == nil {
		meta, err := decodeLegacyBinary(data)
		if err != nil {
			return nil, binaryPath, err
		}
		return &meta, binaryPath, nil
	}
	jsonPath := filepath.Join(dir, "metadata.json")
	if data, err := os.ReadFile(jsonPath); err == nil {
		var meta legacyMetadata
		if err := json.Unmarshal(data, &meta); err != nil {
			return nil, jsonPath, err
		}
		if meta.DBPasswords == nil {
			meta.DBPasswords = map[string]string{}
		}
		return &meta, jsonPath, nil
	}
	return nil, "", nil
}

func migrateLegacyIfNeeded(configPath, vaultPath string) error {
	if fileExists(vaultPath) {
		return nil
	}
	legacy, srcPath, err := loadLegacyMetadata(configPath)
	if err != nil {
		return fmt.Errorf("legacy metadata migration: %w", err)
	}
	if legacy == nil {
		return nil
	}
	store, err := openVaultDB(vaultPath)
	if err != nil {
		return err
	}
	defer store.Close()

	encID := ""
	if legacy.EncID != nil {
		encID = *legacy.EncID
	}
	if encID == "" {
		encID = NewEncID()
	}
	var masterHash, kdfSalt string
	if legacy.MasterPassword != nil {
		masterHash = *legacy.MasterPassword
	}
	if legacy.KdfSalt != nil {
		kdfSalt = *legacy.KdfSalt
	}
	if err := store.SetVaultMeta(masterHash, kdfSalt, encID, legacy.S3SecretKey); err != nil {
		return err
	}
	for key, cipher := range legacy.DBPasswords {
		if err := store.UpsertSecret(key, cipher, RotationCreated); err != nil {
			return err
		}
	}
	_ = store.RecordAudit(ActionConfigInit, StatusSuccess, "legacy_migration", "", fmt.Sprintf("migrated from %s", filepath.Base(srcPath)), "")
	backup := srcPath + ".bak"
	if err := os.Rename(srcPath, backup); err != nil {
		return fmt.Errorf("backup legacy metadata: %w", err)
	}
	return nil
}

func NewEncID() string {
	return strings.ToUpper(strings.ReplaceAll(uuid.New().String(), "-", ""))
}

// LegacyPathForConfig is the old binary metadata path (for doctor/migration hints).
func LegacyPathForConfig(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "metadata")
}

func LegacyMagic() []byte { return legacyMagic }
