package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"

	"github.com/alexedwards/argon2id"
	"golang.org/x/crypto/argon2"
)

var argonParams = &argon2id.Params{
	Memory:      65536,
	Iterations:  3,
	Parallelism: 1,
	SaltLength:  16,
	KeyLength:   32,
}

func randomBytes(n int) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func toB64(buf []byte) string {
	return base64.StdEncoding.EncodeToString(buf)
}

func fromB64(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

func HashMasterPassword(password string) (string, error) {
	return argon2id.CreateHash(password, argonParams)
}

func VerifyMasterPassword(password, encodedHash string) bool {
	match, err := argon2id.ComparePasswordAndHash(password, encodedHash)
	if err != nil {
		return false
	}
	return match
}

func DeriveAESKey(masterPassword, saltB64 string) ([]byte, error) {
	salt, err := fromB64(saltB64)
	if err != nil {
		return nil, err
	}
	key := argon2.IDKey([]byte(masterPassword), salt, argonParams.Iterations, argonParams.Memory, argonParams.Parallelism, argonParams.KeyLength)
	return key, nil
}

func NewKdfSalt() (string, error) {
	salt, err := randomBytes(16)
	if err != nil {
		return "", err
	}
	return toB64(salt), nil
}

func EncryptSecret(key []byte, plaintext string) (string, error) {
	iv, err := randomBytes(12)
	if err != nil {
		return "", err
	}
	ciphertext, err := encryptGCM(key, iv, []byte(plaintext))
	if err != nil {
		return "", err
	}
	out := append(iv, ciphertext...)
	return toB64(out), nil
}

func DecryptSecret(key []byte, payloadB64 string) (string, error) {
	data, err := fromB64(payloadB64)
	if err != nil {
		return "", err
	}
	if len(data) < 12 {
		return "", fmt.Errorf("invalid secret payload")
	}
	plain, err := decryptGCM(key, data[:12], data[12:])
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func EncryptBytes(key, data []byte) ([]byte, error) {
	iv, err := randomBytes(12)
	if err != nil {
		return nil, err
	}
	ciphertext, err := encryptGCM(key, iv, data)
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(iv)+len(ciphertext))
	copy(out, iv)
	copy(out[len(iv):], ciphertext)
	return out, nil
}

func DecryptBytes(key, data []byte) ([]byte, error) {
	if len(data) < 12 {
		return nil, fmt.Errorf("invalid encrypted data")
	}
	return decryptGCM(key, data[:12], data[12:])
}

func encryptGCM(key, iv, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, iv, plaintext, nil), nil
}

func decryptGCM(key, iv, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, iv, ciphertext, nil)
}
