package manifest_test

import (
	"testing"

	"webmcp-automator/server/internal/manifest"
)

func pointer(value string) *string {
	return &value
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
