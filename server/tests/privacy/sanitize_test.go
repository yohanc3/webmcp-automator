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
