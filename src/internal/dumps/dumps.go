package dumps

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/crypto"
)

var encIDRE = regexp.MustCompile(`(?i)_enc_([A-F0-9]+)(\.dump)$`)

func ResolveRoot(dumpDirectory string) string {
	abs, err := filepath.Abs(dumpDirectory)
	if err != nil {
		abs = dumpDirectory
	}
	if strings.EqualFold(filepath.Base(abs), "dumps") {
		return abs
	}
	return filepath.Join(abs, "dumps")
}

func EnsureRootWritable(dumpsRoot string) error {
	if err := os.MkdirAll(dumpsRoot, 0o755); err != nil {
		return err
	}
	probe := filepath.Join(dumpsRoot, fmt.Sprintf(".dumpmgr-write-test-%d", time.Now().UnixNano()))
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return fmt.Errorf("dumps directory is not writable: %s", dumpsRoot)
	}
	return os.Remove(probe)
}

func DumpExtension() string {
	return ".dump"
}

func DumpTimestamp(t time.Time) string {
	return fmt.Sprintf("%04d-%02d-%02d_%02d-%02d-%02d",
		t.UTC().Year(), t.UTC().Month(), t.UTC().Day(),
		t.UTC().Hour(), t.UTC().Minute(), t.UTC().Second())
}

func DBDumpDir(dumpsRoot, itemKey string) string {
	parts := strings.Split(itemKey, ":")
	return filepath.Join(append([]string{dumpsRoot}, parts...)...)
}

func DumpFileKey(itemKey string) string {
	return strings.ReplaceAll(itemKey, ":", "__")
}

func NewDumpFileName(itemKey string) string {
	return fmt.Sprintf("%s_%s%s", DumpFileKey(itemKey), DumpTimestamp(time.Now()), DumpExtension())
}

func IsEncryptedDumpName(fileName string) bool {
	if strings.HasSuffix(fileName, ".enc") {
		return true
	}
	if encIDRE.MatchString(fileName) {
		return true
	}
	return strings.HasSuffix(strings.ToLower(fileName), "_encrypted.dump")
}

func DumpEncIDFromName(fileName string) string {
	m := encIDRE.FindStringSubmatch(fileName)
	if len(m) < 2 {
		return ""
	}
	return strings.ToUpper(m[1])
}

func PlainTempNameFromEncrypted(fileName string) string {
	if strings.HasSuffix(fileName, ".enc") {
		return strings.TrimSuffix(fileName, ".enc")
	}
	name := encIDRE.ReplaceAllString(fileName, "$2")
	re := regexp.MustCompile(`(?i)_encrypted(\.dump)$`)
	return re.ReplaceAllString(name, "$1")
}

func EncryptedPathFromPlain(path, encID string) string {
	base := filepath.Base(path)
	if IsEncryptedDumpName(base) {
		return path
	}
	re := regexp.MustCompile(`(?i)(\.dump)$`)
	return re.ReplaceAllString(path, fmt.Sprintf("_enc_%s$1", encID))
}

func ListDumpFiles(dir string, encryptedOnly bool) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		isDump := strings.HasSuffix(name, ".dump") || strings.HasSuffix(name, ".dump.enc")
		if !isDump {
			continue
		}
		enc := IsEncryptedDumpName(name)
		if encryptedOnly && !enc {
			continue
		}
		if !encryptedOnly && enc {
			continue
		}
		files = append(files, name)
	}
	// sort descending
	for i := 0; i < len(files); i++ {
		for j := i + 1; j < len(files); j++ {
			if files[j] > files[i] {
				files[i], files[j] = files[j], files[i]
			}
		}
	}
	return files, nil
}

type BrowserEntry struct {
	Kind BrowserEntryKind
	Name string
}

type BrowserEntryKind int

const (
	EntryDir BrowserEntryKind = iota
	EntryFile
)

func ListBrowserEntries(dir string, encryptedOnly bool) ([]BrowserEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil
	}
	var dirs, files []BrowserEntry
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.IsDir() {
			dirs = append(dirs, BrowserEntry{Kind: EntryDir, Name: name})
			continue
		}
		isDump := strings.HasSuffix(name, ".dump") || strings.HasSuffix(name, ".dump.enc")
		if !isDump {
			continue
		}
		enc := IsEncryptedDumpName(name)
		if encryptedOnly && !enc {
			continue
		}
		if !encryptedOnly && enc {
			continue
		}
		files = append(files, BrowserEntry{Kind: EntryFile, Name: name})
	}
	sortEntries(dirs)
	sortEntriesDesc(files)
	return append(dirs, files...), nil
}

func sortEntries(entries []BrowserEntry) {
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].Name < entries[i].Name {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
}

func sortEntriesDesc(entries []BrowserEntry) {
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].Name > entries[i].Name {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
}

func EncryptDumpFile(path string, key []byte, encID string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	enc, err := crypto.EncryptBytes(key, raw)
	if err != nil {
		return "", err
	}
	outPath := EncryptedPathFromPlain(path, encID)
	if err := os.WriteFile(outPath, enc, 0o644); err != nil {
		return "", err
	}
	if outPath != path {
		_ = os.Remove(path)
	}
	return outPath, nil
}

func DecryptDumpToTemp(encPath string, key []byte, tempPath string) error {
	data, err := os.ReadFile(encPath)
	if err != nil {
		return err
	}
	plain, err := crypto.DecryptBytes(key, data)
	if err != nil {
		return err
	}
	return os.WriteFile(tempPath, plain, 0o600)
}

func HasEncryptedDumpsWithEncID(dumpsRoot, encID string) (bool, error) {
	want := strings.ToUpper(encID)
	var walk func(string) (bool, error)
	walk = func(dir string) (bool, error) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return false, nil
		}
		for _, e := range entries {
			full := filepath.Join(dir, e.Name())
			if e.IsDir() {
				found, err := walk(full)
				if err != nil || found {
					return found, err
				}
				continue
			}
			if DumpEncIDFromName(e.Name()) == want {
				return true, nil
			}
		}
		return false, nil
	}
	return walk(dumpsRoot)
}

func ReencryptAllDumps(dumpsRoot string, oldKey, newKey []byte, encID string) (int, error) {
	want := strings.ToUpper(encID)
	count := 0
	var walk func(string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil
		}
		for _, e := range entries {
			full := filepath.Join(dir, e.Name())
			if e.IsDir() {
				if err := walk(full); err != nil {
					return err
				}
				continue
			}
			if !IsEncryptedDumpName(e.Name()) {
				continue
			}
			if want != "" && DumpEncIDFromName(e.Name()) != want {
				continue
			}
			data, err := os.ReadFile(full)
			if err != nil {
				return err
			}
			plain, err := crypto.DecryptBytes(oldKey, data)
			if err != nil {
				return err
			}
			enc, err := crypto.EncryptBytes(newKey, plain)
			if err != nil {
				return err
			}
			if err := os.WriteFile(full, enc, 0o644); err != nil {
				return err
			}
			count++
		}
		return nil
	}
	if err := walk(dumpsRoot); err != nil {
		return 0, err
	}
	return count, nil
}

func DeleteEncryptedDumpsWithEncID(dumpsRoot, encID string) (int, error) {
	want := strings.ToUpper(encID)
	count := 0
	var walk func(string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil
		}
		for _, e := range entries {
			full := filepath.Join(dir, e.Name())
			if e.IsDir() {
				if err := walk(full); err != nil {
					return err
				}
				continue
			}
			if DumpEncIDFromName(e.Name()) == want {
				if err := os.Remove(full); err != nil {
					return err
				}
				count++
			}
		}
		return nil
	}
	if err := walk(dumpsRoot); err != nil {
		return 0, err
	}
	return count, nil
}

func FormatBytes(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	if n < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	}
	if n < 1024*1024*1024 {
		return fmt.Sprintf("%.1f MB", float64(n)/(1024*1024))
	}
	return fmt.Sprintf("%.2f GB", float64(n)/(1024*1024*1024))
}

func FormatDuration(ms float64) string {
	return fmt.Sprintf("%.1fs", math.Round(ms/100)/10)
}

func FileSize(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
