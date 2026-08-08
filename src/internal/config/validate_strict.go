package config

import (
	"encoding/json"

	"github.com/tidwall/jsonc"
)

func parseConfigJSON(data string) (*Config, error) {
	standard := jsonc.ToJSON([]byte(data))
	var raw map[string]any
	if err := json.Unmarshal(standard, &raw); err != nil {
		return nil, err
	}
	if items, ok := raw["items"].(map[string]any); ok {
		for key, entry := range items {
			entryMap, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			for field := range entryMap {
				switch field {
				case "host", "port", "user", "database", "readonly", "items":
				default:
					return nil, &validationError{path: "items." + key + "." + field, message: "unknown field"}
				}
			}
			if nested, ok := entryMap["items"].(map[string]any); ok {
				for parentKey, child := range nested {
					childMap, ok := child.(map[string]any)
					if !ok {
						continue
					}
					for field := range childMap {
						switch field {
						case "user", "database":
						default:
							return nil, &validationError{path: "items." + key + ".items." + parentKey + "." + field, message: "unknown field"}
						}
					}
				}
			}
		}
	}
	var cfg Config
	if err := json.Unmarshal(standard, &cfg); err != nil {
		return nil, err
	}
	if _, ok := raw["rememberPassword"]; !ok {
		cfg.RememberPassword = true
	}
	if s3raw, ok := raw["s3Options"].(map[string]any); ok && cfg.S3Options != nil {
		if _, ok := s3raw["useHttps"]; !ok {
			cfg.S3Options.UseHTTPS = true
		}
		if _, ok := s3raw["forcePathStyle"]; !ok {
			cfg.S3Options.ForcePathStyle = true
		}
	}
	ApplyDefaults(&cfg)
	if issues := ValidateConfig(&cfg); len(issues) > 0 {
		return nil, &validationError{message: issues[0]}
	}
	return &cfg, nil
}

type validationError struct {
	path    string
	message string
}

func (e *validationError) Error() string {
	if e.path != "" {
		return e.path + ": " + e.message
	}
	return e.message
}
