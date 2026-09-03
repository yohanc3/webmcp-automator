package manifest_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"webmcp-automator/server/internal/manifest"
)

func pointer(value string) *string {
	return &value
}

func ownedStorefrontActionList(t *testing.T) json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "documentation", "contracts", "examples", "owned-storefront.action-list.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func ownedStorefrontBasketActionList(t *testing.T) json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "documentation", "contracts", "examples", "owned-storefront-basket.action-list.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestOwnedStorefrontBasketRequiresExactWriteConfirmation(t *testing.T) {
	list, err := manifest.DecodeActionList(ownedStorefrontBasketActionList(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Actions) != 1 || list.Actions[0].ID != "add_field_h1_to_basket" {
		t.Fatalf("unexpected basket fixture actions: %#v", list.Actions)
	}
	action := list.Actions[0]
	if action.Safety.Class != "write" || action.Safety.Confirmation != "before_step" ||
		action.Safety.ConfirmationStepID == nil || *action.Safety.ConfirmationStepID != "add_field_h1" {
		t.Fatalf("basket action is not bound to exact write confirmation: %#v", action.Safety)
	}
}

func TestActionListAcceptsOwnedStorefrontContract(t *testing.T) {
	list, err := manifest.DecodeActionList(ownedStorefrontActionList(t))
	if err != nil {
		t.Fatalf("decode owned storefront action list: %v", err)
	}
	if list.ListID != "owned_storefront" || len(list.Actions) != 1 {
		t.Fatalf("unexpected action list: %#v", list)
	}
	if !manifest.MatchesLocation(list, "http://127.0.0.1:4317/demo/search?q=headphones") {
		t.Fatal("expected exact-origin storefront route to match")
	}
	if manifest.MatchesLocation(list, "http://localhost:4317/demo/search?q=headphones") ||
		manifest.MatchesLocation(list, "http://127.0.0.1:4317/admin") {
		t.Fatal("route matching accepted the wrong origin or route")
	}
}

func TestActionListDigestIsCanonicalAndPublishedDigestVerifies(t *testing.T) {
	raw := ownedStorefrontActionList(t)
	first, err := manifest.CandidateDigest(raw)
	if err != nil {
		t.Fatal(err)
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	reformatted, err := json.MarshalIndent(value, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	second, err := manifest.CandidateDigest(reformatted)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("canonical digest changed with formatting: %s != %s", first, second)
	}
	published, digest, err := manifest.PublishActionList(raw, time.Date(2026, 9, 3, 1, 2, 3, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if digest == first {
		t.Fatal("published projection should have its own immutable content digest")
	}
	if err := manifest.VerifyDigest(published, digest); err != nil {
		t.Fatalf("verify published digest: %v", err)
	}
	if !bytes.Contains(published, []byte(`"status":"published"`)) ||
		!bytes.Contains(published, []byte(`"lifecycle":"published"`)) {
		t.Fatalf("published projection did not publish list and action: %s", published)
	}
}

func TestActionListRejectsArbitraryJavaScriptFields(t *testing.T) {
	var value map[string]any
	if err := json.Unmarshal(ownedStorefrontActionList(t), &value); err != nil {
		t.Fatal(err)
	}
	actions := value["actions"].([]any)
	steps := actions[0].(map[string]any)["steps"].([]any)
	steps[0].(map[string]any)["javascript"] = "fetch('/steal')"
	malicious, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manifest.DecodeActionList(malicious)
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected arbitrary JavaScript field rejection, got %v", err)
	}
}

func TestActionListRejectsMissingRequiredBoolean(t *testing.T) {
	var value map[string]any
	if err := json.Unmarshal(ownedStorefrontActionList(t), &value); err != nil {
		t.Fatal(err)
	}
	delete(value["site"].(map[string]any), "topFrameOnly")
	invalid, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manifest.DecodeActionList(invalid)
	if err == nil || !strings.Contains(err.Error(), "topFrameOnly is required") {
		t.Fatalf("expected required-field rejection, got %v", err)
	}
}

func validAdapter() manifest.Adapter {
	return manifest.Adapter{
		SchemaVersion: manifest.SchemaVersion,
		Usable:        true,
		Site:          manifest.Site{Origin: "https://example.com", RoutePatterns: []string{"/search"}},
		Tool: manifest.Tool{
			Name:        "search_products",
			Description: "Search products",
			Safety:      "read",
			Parameters: []manifest.Parameter{{
				Name: "query", Description: "Search query", Type: "string", Required: true,
			}},
			Steps: []manifest.Step{{
				Operation: "fill", Target: manifest.Locator{CSS: pointer("#search")},
				ValueFrom: pointer("query"), TimeoutMS: 5000,
			}},
			Output: manifest.Output{Mode: "page", Limit: 10},
		},
		Confidence: 0.9,
	}
}

func TestValidateAcceptsDeterministicAdapter(t *testing.T) {
	if err := validAdapter().Validate(); err != nil {
		t.Fatalf("expected valid adapter, got %v", err)
	}
}

func TestValidateRejectsUnknownParameter(t *testing.T) {
	adapter := validAdapter()
	adapter.Tool.Steps[0].ValueFrom = pointer("missing")
	if err := adapter.Validate(); err == nil {
		t.Fatal("expected adapter validation to fail")
	}
}
