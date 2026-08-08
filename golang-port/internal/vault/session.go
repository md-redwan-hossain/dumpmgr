package vault

import (
	"fmt"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/crypto"
)

type Session struct {
	Store          *Store
	MasterPassword string
	AESKey         []byte
}

func Unlock(configPath, masterPassword string) (*Session, error) {
	store, err := Open(configPath)
	if err != nil {
		return nil, err
	}
	has, err := store.HasMaster()
	if err != nil {
		store.Close()
		return nil, err
	}
	if !has {
		store.Close()
		return nil, fmt.Errorf("vault has no master password; run config init again")
	}
	masterHash, kdfSalt, encID, _, err := store.VaultMeta()
	if err != nil {
		store.Close()
		return nil, err
	}
	if !encID.Valid || encID.String == "" {
		if err := store.SetEncID(NewEncID()); err != nil {
			store.Close()
			return nil, err
		}
	}
	if !crypto.VerifyMasterPassword(masterPassword, masterHash.String) {
		store.Close()
		return nil, fmt.Errorf("incorrect master password")
	}
	aesKey, err := crypto.DeriveAESKey(masterPassword, kdfSalt.String)
	if err != nil {
		store.Close()
		return nil, err
	}
	return &Session{Store: store, MasterPassword: masterPassword, AESKey: aesKey}, nil
}

func (s *Session) Close() error {
	if s.Store != nil {
		return s.Store.Close()
	}
	return nil
}

func (s *Session) EncID() (string, error) {
	return s.Store.EncID()
}

func CreateWithMaster(configPath, masterPassword string) (*Session, error) {
	store, err := Open(configPath)
	if err != nil {
		return nil, err
	}
	hash, err := crypto.HashMasterPassword(masterPassword)
	if err != nil {
		store.Close()
		return nil, err
	}
	salt, err := crypto.NewKdfSalt()
	if err != nil {
		store.Close()
		return nil, err
	}
	encID := NewEncID()
	if err := store.SetVaultMeta(hash, salt, encID, nil); err != nil {
		store.Close()
		return nil, err
	}
	aesKey, err := crypto.DeriveAESKey(masterPassword, salt)
	if err != nil {
		store.Close()
		return nil, err
	}
	return &Session{Store: store, MasterPassword: masterPassword, AESKey: aesKey}, nil
}

func InitEmpty(configPath string) (*Store, error) {
	return Open(configPath)
}

func GetDBPassword(session *Session, key string) (string, error) {
	cipher, ok, err := session.Store.GetSecretCiphertext(key)
	if err != nil || !ok || session.AESKey == nil {
		return "", err
	}
	pw, err := crypto.DecryptSecret(session.AESKey, cipher)
	if err != nil {
		return "", err
	}
	_ = session.Store.TouchSecretUsed(key)
	return pw, nil
}

func SetDBPassword(session *Session, key, password string) error {
	if session.AESKey == nil {
		return fmt.Errorf("AES key missing; master password required")
	}
	enc, err := crypto.EncryptSecret(session.AESKey, password)
	if err != nil {
		return err
	}
	return session.Store.UpsertSecret(key, enc, "")
}

func GetS3SecretKey(session *Session) (string, error) {
	_, _, _, s3Key, err := session.Store.VaultMeta()
	if err != nil || !s3Key.Valid || session.AESKey == nil {
		return "", err
	}
	return crypto.DecryptSecret(session.AESKey, s3Key.String)
}

func SetS3SecretKey(session *Session, secretKey string) error {
	if session.AESKey == nil {
		return fmt.Errorf("AES key missing; master password required")
	}
	enc, err := crypto.EncryptSecret(session.AESKey, secretKey)
	if err != nil {
		return err
	}
	return session.Store.SetS3SecretKey(enc)
}

func DeleteDBPassword(session *Session, key string) (bool, error) {
	return session.Store.DeleteSecret(key)
}

func ChangeMasterPassword(session *Session, newMaster string) (*Session, error) {
	if session.AESKey == nil {
		return nil, fmt.Errorf("current session has no AES key")
	}
	secrets, err := session.Store.ListSecrets()
	if err != nil {
		return nil, err
	}
	plain := make(map[string]string)
	for _, info := range secrets {
		cipher, ok, err := session.Store.GetSecretCiphertext(info.Key)
		if err != nil || !ok {
			continue
		}
		pw, err := crypto.DecryptSecret(session.AESKey, cipher)
		if err != nil {
			return nil, err
		}
		plain[info.Key] = pw
	}
	salt, err := crypto.NewKdfSalt()
	if err != nil {
		return nil, err
	}
	newKey, err := crypto.DeriveAESKey(newMaster, salt)
	if err != nil {
		return nil, err
	}
	hash, err := crypto.HashMasterPassword(newMaster)
	if err != nil {
		return nil, err
	}
	encID, err := session.EncID()
	if err != nil {
		return nil, err
	}
	if encID == "" {
		encID = NewEncID()
	}
	var s3Plain string
	if sk, err := GetS3SecretKey(session); err == nil {
		s3Plain = sk
	}
	var s3Enc *string
	if s3Plain != "" {
		enc, err := crypto.EncryptSecret(newKey, s3Plain)
		if err != nil {
			return nil, err
		}
		s3Enc = &enc
	}
	if err := session.Store.SetVaultMeta(hash, salt, encID, s3Enc); err != nil {
		return nil, err
	}
	for key, pw := range plain {
		enc, err := crypto.EncryptSecret(newKey, pw)
		if err != nil {
			return nil, err
		}
		if err := session.Store.UpsertSecret(key, enc, RotationMasterReencrypt); err != nil {
			return nil, err
		}
	}
	_ = session.Store.RecordAudit(ActionMasterChange, StatusSuccess, "", "", "master password changed", "")
	return &Session{Store: session.Store, MasterPassword: newMaster, AESKey: newKey}, nil
}
