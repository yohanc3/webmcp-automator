package actionmap_test

import (
	"testing"

	"webmcp-automator/server/internal/actionmap"
)

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

func validMap() actionmap.Map {
	stateID := "results"
	return actionmap.Map{
		SchemaVersion: actionmap.SchemaVersion,
		Site: actionmap.Site{
			Origin:       "https://example.com",
			ObservedURLs: []string{"https://example.com/search"},
		},
		Summary: "A catalog search flow",
		States: []actionmap.State{{
			ID: "catalog", Label: "Catalog", URLPattern: "^https://example.com/search",
			Evidence: []string{"search form"},
		}, {
			ID: "results", Label: "Results", URLPattern: "^https://example.com/results",
			Evidence: []string{"repeated products"},
		}},
		Actions: []actionmap.Action{{
			ID: "search_products", Name: "Search products",
			Description: "Search the catalog and read matching products",
			Category:    "submit", Status: "observed", Safety: "read", Confidence: 0.9,
			FromState: "catalog", ToState: &stateID,
			Parameters: []actionmap.Parameter{{
				Name: "query", Description: "Catalog search text", Type: "string", Required: true,
			}},
			Steps: []actionmap.Step{{
				Operation: "fill", Target: actionmap.Locator{Role: pointer("searchbox")},
				ValueFrom: pointer("query"),
				Expect:    actionmap.Expectation{Kind: "none"}, TimeoutMS: 5000,
			}, {
				Operation: "click", Target: actionmap.Locator{Role: pointer("button"), Name: pointer("Search")},
				Expect: actionmap.Expectation{Kind: "navigation", State: &stateID}, TimeoutMS: 10000,
			}},
			Output:   actionmap.Output{Mode: "none", Limit: 10},
			Evidence: []string{"fill followed by submit and results"},
		}},
		Privacy: actionmap.Privacy{Policy: "Sensitive values removed before discovery"},
	}
}

func pointer(value string) *string {
	return &value
}
