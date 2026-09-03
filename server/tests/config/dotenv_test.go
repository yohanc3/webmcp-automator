package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"webmcp-automator/server/internal/config"
)

func TestLoadDotEnvKeepsUnquotedAmpersandInsideValue(t *testing.T) {
	const key = "WEBMCP_TEST_DATABASE_URL"
	restoreEnvironment(t, key)
	path := writeDotEnv(t, key+"=postgresql://user:password@host/database?sslmode=require&channel_binding=require\n")

	if err := config.LoadDotEnv(path); err != nil {
		t.Fatalf("load dotenv: %v", err)
	}
	want := "postgresql://user:password@host/database?sslmode=require&channel_binding=require"
	if got := os.Getenv(key); got != want {
		t.Fatalf("unexpected value: %q", got)
	}
}

func TestLoadDotEnvSupportsQuotedValues(t *testing.T) {
	const singleKey = "WEBMCP_TEST_SINGLE_QUOTED"
	const doubleKey = "WEBMCP_TEST_DOUBLE_QUOTED"
	restoreEnvironment(t, singleKey)
	restoreEnvironment(t, doubleKey)
	path := writeDotEnv(t, singleKey+"='literal & value'\n"+doubleKey+"=\"escaped\\nvalue\"\n")

	if err := config.LoadDotEnv(path); err != nil {
		t.Fatalf("load dotenv: %v", err)
	}
	if got := os.Getenv(singleKey); got != "literal & value" {
		t.Fatalf("unexpected single-quoted value: %q", got)
	}
	if got := os.Getenv(doubleKey); got != "escaped\nvalue" {
		t.Fatalf("unexpected double-quoted value: %q", got)
	}
}

func TestLoadDotEnvDoesNotOverrideProcessEnvironment(t *testing.T) {
	const key = "WEBMCP_TEST_PROCESS_OVERRIDE"
	t.Setenv(key, "from-process")
	path := writeDotEnv(t, key+"=from-file\n")

	if err := config.LoadDotEnv(path); err != nil {
		t.Fatalf("load dotenv: %v", err)
	}
	if got := os.Getenv(key); got != "from-process" {
		t.Fatalf("dotenv overrode process environment: %q", got)
	}
}

func TestLoadDotEnvIgnoresMissingFile(t *testing.T) {
	if err := config.LoadDotEnv(filepath.Join(t.TempDir(), "missing.env")); err != nil {
		t.Fatalf("missing dotenv file should be optional: %v", err)
	}
}

func writeDotEnv(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write dotenv fixture: %v", err)
	}
	return path
}

func restoreEnvironment(t *testing.T, key string) {
	t.Helper()
	value, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("unset test variable: %v", err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, value)
			return
		}
		_ = os.Unsetenv(key)
	})
}
