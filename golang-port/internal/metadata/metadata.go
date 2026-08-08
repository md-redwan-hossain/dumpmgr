package metadata

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/crypto"
)

const Version = 1

var magic = []byte("DBSM")

type Metadata struct {
	MasterPassword *string           `json:"masterPassword,omitempty"`
	KdfSalt        *string           `json:"kdfSalt,omitempty"`
	DBPasswords    map[string]string `json:"dbPasswords"`
	EncID          *string           `json:"encId,omitempty"`
	S3SecretKey    *string           `json:"s3SecretKey,omitempty"`
}

type Session struct {
	MasterPassword string
	AESKey         []byte
	Metadata       Metadata
	MetadataPath   string
}

func NewEncID() string {
	return strings.ToUpper(strings.ReplaceAll(uuid.New().String(), "-", ""))
}

func PathForConfig(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "metadata")
}

func encodeBinary(meta Metadata) ([]byte, error) {
	if meta.DBPasswords == nil {
		meta.DBPasswords = map[string]string{}
	}
	jsonData, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	if _, err := gw.Write(jsonData); err != nil {
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}
	gz := gzBuf.Bytes()
	out := make([]byte, len(magic)+1+len(gz))
	copy(out, magic)
	out[len(magic)] = Version
	copy(out[len(magic)+1:], gz)
	return out, nil
}

func decodeBinary(buf []byte) (Metadata, error) {
	if len(buf) < len(magic)+2 {
		return Metadata{}, fmt.Errorf("invalid metadata file (too short)")
	}
	for i := range magic {
		if buf[i] != magic[i] {
			return Metadata{}, fmt.Errorf("invalid metadata file (bad magic)")
		}
	}
	version := buf[len(magic)]
	if version != Version {
		return Metadata{}, fmt.Errorf("unsupported metadata version: %d", version)
	}
	gr, err := gzip.NewReader(bytes.NewReader(buf[len(magic)+1:]))
	if err != nil {
		return Metadata{}, fmt.Errorf("invalid metadata gzip: %w", err)
	}
	defer gr.Close()
	var meta Metadata
	if err := json.NewDecoder(gr).Decode(&meta); err != nil {
		return Metadata{}, fmt.Errorf("invalid metadata payload")
	}
	if meta.DBPasswords == nil {
		meta.DBPasswords = map[string]string{}
	}
	return meta, nil
}

func migrateFromJSONIfNeeded(binaryPath string) (*Metadata, error) {
	jsonPath := filepath.Join(filepath.Dir(binaryPath), "metadata.json")
	if _, err := os.Stat(jsonPath); os.IsNotExist(err) {
		return nil, nil
	}
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil, err
	}
	var meta Metadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("invalid legacy metadata.json: %s", jsonPath)
	}
	if meta.DBPasswords == nil {
		meta.DBPasswords = map[string]string{}
	}
	if meta.EncID == nil || *meta.EncID == "" {
		id := NewEncID()
		meta.EncID = &id
	}
	if err := Write(binaryPath, meta); err != nil {
		return nil, err
	}
	if err := os.Remove(jsonPath); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return &meta, nil
}

func Load(path string) (Metadata, error) {
	if data, err := os.ReadFile(path); err == nil {
		return decodeBinary(data)
	} else if !os.IsNotExist(err) {
		return Metadata{}, err
	}
	migrated, err := migrateFromJSONIfNeeded(path)
	if err != nil {
		return Metadata{}, err
	}
	if migrated != nil {
		return *migrated, nil
	}
	return Metadata{DBPasswords: map[string]string{}}, nil
}

func Write(path string, meta Metadata) error {
	if meta.DBPasswords == nil {
		meta.DBPasswords = map[string]string{}
	}
	data, err := encodeBinary(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func CreateWithMaster(path, masterPassword string) (Metadata, error) {
	hash, err := crypto.HashMasterPassword(masterPassword)
	if err != nil {
		return Metadata{}, err
	}
	salt, err := crypto.NewKdfSalt()
	if err != nil {
		return Metadata{}, err
	}
	id := NewEncID()
	meta := Metadata{
		MasterPassword: &hash,
		KdfSalt:        &salt,
		DBPasswords:    map[string]string{},
		EncID:          &id,
	}
	if err := Write(path, meta); err != nil {
		return Metadata{}, err
	}
	return meta, nil
}

func Empty(path string) (Metadata, error) {
	meta := Metadata{DBPasswords: map[string]string{}}
	if err := Write(path, meta); err != nil {
		return Metadata{}, err
	}
	return meta, nil
}

func Unlock(metadataPath, masterPassword string) (*Session, error) {
	meta, err := Load(metadataPath)
	if err != nil {
		return nil, err
	}
	if meta.MasterPassword == nil || meta.KdfSalt == nil {
		return nil, fmt.Errorf("metadata has no master password; run config init again")
	}
	if meta.EncID == nil || *meta.EncID == "" {
		id := NewEncID()
		meta.EncID = &id
		if err := Write(metadataPath, meta); err != nil {
			return nil, err
		}
	}
	if !crypto.VerifyMasterPassword(masterPassword, *meta.MasterPassword) {
		return nil, fmt.Errorf("incorrect master password")
	}
	aesKey, err := crypto.DeriveAESKey(masterPassword, *meta.KdfSalt)
	if err != nil {
		return nil, err
	}
	return &Session{
		MasterPassword: masterPassword,
		AESKey:         aesKey,
		Metadata:       meta,
		MetadataPath:   metadataPath,
	}, nil
}

func GetDBPassword(session *Session, key string) (string, error) {
	cipherText, ok := session.Metadata.DBPasswords[key]
	if !ok || session.AESKey == nil {
		return "", nil
	}
	return crypto.DecryptSecret(session.AESKey, cipherText)
}

func SetDBPassword(session *Session, key, password string) error {
	if session.AESKey == nil {
		return fmt.Errorf("AES key missing; master password required")
	}
	enc, err := crypto.EncryptSecret(session.AESKey, password)
	if err != nil {
		return err
	}
	session.Metadata.DBPasswords[key] = enc
	return Write(session.MetadataPath, session.Metadata)
}

func GetS3SecretKey(session *Session) (string, error) {
	if session.Metadata.S3SecretKey == nil || session.AESKey == nil {
		return "", nil
	}
	return crypto.DecryptSecret(session.AESKey, *session.Metadata.S3SecretKey)
}

func SetS3SecretKey(session *Session, secretKey string) error {
	if session.AESKey == nil {
		return fmt.Errorf("AES key missing; master password required")
	}
	enc, err := crypto.EncryptSecret(session.AESKey, secretKey)
	if err != nil {
		return err
	}
	session.Metadata.S3SecretKey = &enc
	return Write(session.MetadataPath, session.Metadata)
}

func DeleteDBPassword(session *Session, key string) (bool, error) {
	if _, ok := session.Metadata.DBPasswords[key]; !ok {
		return false, nil
	}
	delete(session.Metadata.DBPasswords, key)
	if err := Write(session.MetadataPath, session.Metadata); err != nil {
		return false, err
	}
	return true, nil
}

func ChangeMasterPassword(session *Session, newMaster string) (*Session, error) {
	if session.AESKey == nil {
		return nil, fmt.Errorf("current session has no AES key")
	}
	plain := make(map[string]string)
	for k, cipher := range session.Metadata.DBPasswords {
		pw, err := crypto.DecryptSecret(session.AESKey, cipher)
		if err != nil {
			return nil, err
		}
		plain[k] = pw
	}
	salt, err := crypto.NewKdfSalt()
	if err != nil {
		return nil, err
	}
	newKey, err := crypto.DeriveAESKey(newMaster, salt)
	if err != nil {
		return nil, err
	}
	dbPasswords := make(map[string]string)
	for k, pw := range plain {
		enc, err := crypto.EncryptSecret(newKey, pw)
		if err != nil {
			return nil, err
		}
		dbPasswords[k] = enc
	}
	hash, err := crypto.HashMasterPassword(newMaster)
	if err != nil {
		return nil, err
	}
	encID := session.Metadata.EncID
	if encID == nil || *encID == "" {
		id := NewEncID()
		encID = &id
	}
	meta := Metadata{
		MasterPassword: &hash,
		KdfSalt:        &salt,
		DBPasswords:    dbPasswords,
		EncID:          encID,
		S3SecretKey:    session.Metadata.S3SecretKey,
	}
	if err := Write(session.MetadataPath, meta); err != nil {
		return nil, err
	}
	return &Session{
		MasterPassword: newMaster,
		AESKey:         newKey,
		Metadata:       meta,
		MetadataPath:   session.MetadataPath,
	}, nil
}

func Magic() []byte {
	return magic
}
