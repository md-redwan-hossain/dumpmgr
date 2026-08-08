package metadata

import (
	"github.com/md-redwan-hossain/dumpmgr/src/internal/vault"
)

// Version is kept for doctor compatibility with legacy DBSM files.
const Version = 1

type Session = vault.Session

func PathForConfig(configPath string) string {
	return vault.DBPathForConfig(configPath)
}

func DBPathForConfig(configPath string) string {
	return vault.DBPathForConfig(configPath)
}

func LegacyPathForConfig(configPath string) string {
	return vault.LegacyPathForConfig(configPath)
}

func Magic() []byte { return vault.LegacyMagic() }

func NewEncID() string { return vault.NewEncID() }

func Open(configPath string) (*vault.Store, error) {
	return vault.Open(configPath)
}

func Unlock(configPath, masterPassword string) (*Session, error) {
	return vault.Unlock(configPath, masterPassword)
}

func CreateWithMaster(configPath, masterPassword string) (*Session, error) {
	return vault.CreateWithMaster(configPath, masterPassword)
}

func Empty(configPath string) error {
	store, err := vault.Open(configPath)
	if err != nil {
		return err
	}
	return store.Close()
}

func GetDBPassword(session *Session, key string) (string, error) {
	return vault.GetDBPassword(session, key)
}

func SetDBPassword(session *Session, key, password string) error {
	return vault.SetDBPassword(session, key, password)
}

func GetS3SecretKey(session *Session) (string, error) {
	return vault.GetS3SecretKey(session)
}

func SetS3SecretKey(session *Session, secretKey string) error {
	return vault.SetS3SecretKey(session, secretKey)
}

func DeleteDBPassword(session *Session, key string) (bool, error) {
	return vault.DeleteDBPassword(session, key)
}

func ChangeMasterPassword(session *Session, newMaster string) (*Session, error) {
	return vault.ChangeMasterPassword(session, newMaster)
}

func EncID(session *Session) (string, error) {
	return session.EncID()
}
