package actionmap

import "testing"

func TestValidateAcceptsObservedActionMap(t *testing.T) {
	actionMap := validMap()
	if err := actionMap.Validate(); err != nil {
		t.Fatalf("expected valid action map: %v", err)
	}
}

func TestValidateRejectsUnknownStateReference(t *testing.T) {
	actionMap := validMap()
	actionMap.Actions[0].FromState = "missing"
	if err := actionMap.Validate(); err == nil {
		t.Fatal("expected unknown state reference to fail")
	}
}

func TestValidateRequiresStepsForResolvableActions(t *testing.T) {
	actionMap := validMap()
	actionMap.Actions[0].Status = "resolvable"
	actionMap.Actions[0].Steps = nil
	if err := actionMap.Validate(); err == nil {
		t.Fatal("expected resolvable action without steps to fail")
	}
}

func validMap() Map {
	stateID := "results"
	return Map{
		SchemaVersion: SchemaVersion,
		Site: Site{
			Origin:       "https://example.com",
			ObservedURLs: []string{"https://example.com/search"},
		},
		Summary: "A catalog search flow",
		States: []State{{
			ID: "catalog", Label: "Catalog", URLPattern: "^https://example.com/search",
			Evidence: []string{"search form"},
		}, {
			ID: "results", Label: "Results", URLPattern: "^https://example.com/results",
			Evidence: []string{"repeated products"},
		}},
		Actions: []Action{{
			ID: "search_products", Name: "Search products",
			Description: "Search the catalog and read matching products",
			Category:    "submit", Status: "observed", Safety: "read", Confidence: 0.9,
			FromState: "catalog", ToState: &stateID,
			Parameters: []Parameter{{
				Name: "query", Description: "Catalog search text", Type: "string", Required: true,
			}},
			Steps: []Step{{
				Operation: "fill", Target: Locator{Role: pointer("searchbox")},
				ValueFrom: pointer("query"),
				Expect:    Expectation{Kind: "none"}, TimeoutMS: 5000,
			}, {
				Operation: "click", Target: Locator{Role: pointer("button"), Name: pointer("Search")},
				Expect: Expectation{Kind: "navigation", State: &stateID}, TimeoutMS: 10000,
			}},
			Output:   Output{Mode: "none", Limit: 10},
			Evidence: []string{"fill followed by submit and results"},
		}},
		Privacy: Privacy{Policy: "Sensitive values removed before discovery"},
	}
}

func pointer(value string) *string {
	return &value
}
