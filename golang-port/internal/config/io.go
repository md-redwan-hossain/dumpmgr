package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/hujson"
	"github.com/tidwall/jsonc"
)

func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func ReadFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("config file not found: %s", path)
		}
		return nil, err
	}
	return data, nil
}

func ParseJSONC(data []byte) (*Config, error) {
	cfg, err := parseConfigJSON(string(data))
	if err != nil {
		return nil, fmt.Errorf("invalid JSONC in config file: %w", err)
	}
	return cfg, nil
}

func Load(path string) (*Config, error) {
	data, err := ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg, err := ParseJSONC(data)
	if err != nil {
		return nil, fmt.Errorf("invalid config (%s): %w", path, err)
	}
	return cfg, nil
}

func Write(path string, cfg Config) error {
	ApplyDefaults(&cfg)
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}

func LintFile(path string) error {
	data, err := ReadFile(path)
	if err != nil {
		return err
	}
	formatted, err := hujson.Format(data)
	if err != nil {
		return fmt.Errorf("invalid JSONC in config file: %s: %w", path, err)
	}
	if len(formatted) == 0 || formatted[len(formatted)-1] != '\n' {
		formatted = append(formatted, '\n')
	}
	return os.WriteFile(path, formatted, 0o644)
}

func ValidateFile(path string) ValidateResult {
	data, err := ReadFile(path)
	if err != nil {
		return ValidateResult{OK: false, Issues: []string{err.Error()}}
	}
	standard := jsonc.ToJSON(data)
	var cfg Config
	if err := json.Unmarshal(standard, &cfg); err != nil {
		return ValidateResult{OK: false, Issues: []string{fmt.Sprintf("invalid JSONC: %v", err)}}
	}
	ApplyDefaults(&cfg)
	if issues := ValidateConfig(&cfg); len(issues) > 0 {
		return ValidateResult{OK: false, Issues: issues}
	}
	result := BuildValidateReport(&cfg)
	result.OK = true
	return result
}

func ResolvePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}
