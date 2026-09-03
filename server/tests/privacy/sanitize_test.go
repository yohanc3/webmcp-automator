package privacy_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"webmcp-automator/server/internal/privacy"
)

func TestSanitizeTraceRemovesSensitiveEvidence(t *testing.T) {
	input := json.RawMessage(`{
		"initialState": {
			"url": "https://shop.example/search?q=headphones&account=42",
			"semanticXml": "<page>Hello, Elijah</page>",
			"nodes": [{
				"name": "Deliver to Elijah",
				"text": "elijah@example.com 123 Main Street 4111 1111 1111 1111"
			}]
		},
		"steps": [{"event": {"value": {"redacted": false, "value": "headphones"}}}]
	}`)

	output, summary, err := privacy.SanitizeTrace(input)
	if err != nil {
		t.Fatal(err)
	}
	text := string(output)
	for _, secret := range []string{"headphones", "Elijah", "elijah@example.com", "123 Main Street", "4111"} {
		if strings.Contains(text, secret) {
			t.Fatalf("sanitized trace still contains %q: %s", secret, text)
		}
	}
	if strings.Contains(text, "semanticXml") {
		t.Fatalf("sanitized trace retained duplicate XML: %s", text)
	}
	if summary.RedactionsApplied < 6 {
		t.Fatalf("expected multiple redactions, got %#v", summary)
	}
}

func TestStorefrontFixtureRemovesModelBoundaryDuplicatesAndInputs(t *testing.T) {
	trace, err := os.ReadFile(filepath.Join("..", "fixtures", "storefront-search-trace.json"))
	if err != nil {
		t.Fatal(err)
	}
	sanitized, summary, err := privacy.SanitizeTrace(trace)
	if err != nil {
		t.Fatal(err)
	}
	text := string(sanitized)
	for _, forbidden := range []string{
		`"semanticXml"`,
		`"value":"headphones"`,
		`?q=headphones`,
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("sanitized storefront trace contains %q", forbidden)
		}
	}
	if summary.RedactionsApplied < 3 {
		t.Fatalf("expected duplicate input and URL redactions, got %#v", summary)
	}
}

func TestSanitizeTraceRejectsInvalidJSON(t *testing.T) {
	if _, _, err := privacy.SanitizeTrace(json.RawMessage(`{"trace":`)); err == nil {
		t.Fatal("expected invalid JSON to be rejected")
	}
}

func TestSanitizeTracePreservesChronologyAndRemovesCredentialCanary(t *testing.T) {
	input := json.RawMessage(`{"startedAt":"2026-09-03T01:02:03.000Z","note":"sk-abcdefghijklmnop1234"}`)
	output, _, err := privacy.SanitizeTrace(input)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), "2026-09-03T01:02:03.000Z") {
		t.Fatalf("timestamp was corrupted: %s", output)
	}
	if strings.Contains(string(output), "sk-abcdefghijklmnop1234") {
		t.Fatalf("credential canary survived: %s", output)
	}
	findings, err := privacy.Scan(json.RawMessage(`{"description":"email privacy-canary@example.com"}`))
	if err != nil || len(findings) != 1 || findings[0].Path != "$.description" {
		t.Fatalf("unexpected scan findings: %#v %v", findings, err)
	}
}
