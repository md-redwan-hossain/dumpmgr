package crypto_test

import (
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/crypto"
)

func TestSecretAndBytesRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	secret, err := crypto.EncryptSecret(key, "database password")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := crypto.DecryptSecret(key, secret)
	if err != nil || plain != "database password" {
		t.Fatalf("secret round trip failed: %q %v", plain, err)
	}

	bytes, err := crypto.EncryptBytes(key, []byte("dump"))
	if err != nil {
		t.Fatal(err)
	}
	out, err := crypto.DecryptBytes(key, bytes)
	if err != nil || string(out) != "dump" {
		t.Fatalf("bytes round trip failed: %q %v", out, err)
	}
	bytes[len(bytes)-1] ^= 1
	if _, err := crypto.DecryptBytes(key, bytes); err == nil {
		t.Fatal("expected tamper detection failure")
	}
}

func TestMasterPasswordHashAndDerive(t *testing.T) {
	hash, err := crypto.HashMasterPassword("test-password")
	if err != nil {
		t.Fatal(err)
	}
	if !crypto.VerifyMasterPassword("test-password", hash) {
		t.Fatal("expected password verification to succeed")
	}
	salt, err := crypto.NewKdfSalt()
	if err != nil {
		t.Fatal(err)
	}
	a, err := crypto.DeriveAESKey("test-password", salt)
	if err != nil {
		t.Fatal(err)
	}
	b, err := crypto.DeriveAESKey("test-password", salt)
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 32 || string(a) != string(b) {
		t.Fatal("expected deterministic AES key derivation")
	}
}
