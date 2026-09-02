package manifest

import "testing"

func pointer(value string) *string {
	return &value
}

func validAdapter() Adapter {
	return Adapter{
		SchemaVersion: SchemaVersion,
		Usable:        true,
		Site:          Site{Origin: "https://example.com", RoutePatterns: []string{"/search"}},
		Tool: Tool{
			Name:        "search_products",
			Description: "Search products",
			Safety:      "read",
			Parameters: []Parameter{{
				Name: "query", Description: "Search query", Type: "string", Required: true,
			}},
			Steps: []Step{{
				Operation: "fill", Target: Locator{CSS: pointer("#search")},
				ValueFrom: pointer("query"), TimeoutMS: 5000,
			}},
			Output: Output{Mode: "page", Limit: 10},
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
