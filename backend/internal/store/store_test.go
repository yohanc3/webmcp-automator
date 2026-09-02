package store

import (
	"context"
	"encoding/json"
	"testing"

	"webmcp-automator/backend/internal/actionmap"
	"webmcp-automator/backend/internal/learning"
)

func TestSaveDiscoveryPersistsActionMapHistory(t *testing.T) {
	database, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer database.Close()
	ctx := context.Background()
	session, err := database.CreateSession(
		ctx,
		learning.DiscoveryGoal,
		"https://example.com/",
		"https://example.com/results",
		json.RawMessage(`{"steps":[]}`),
	)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	discovery, err := database.SaveDiscovery(ctx, session.ID, learning.Result{
		ActionMap:  testActionMap(),
		Model:      "openai/gpt-oss-120b",
		ResponseID: "generation_test",
	})
	if err != nil {
		t.Fatalf("save discovery: %v", err)
	}
	if discovery.SessionID != session.ID || discovery.ActionMap.Actions[0].ID != "search_products" {
		t.Fatalf("unexpected discovery: %#v", discovery)
	}

	var count int
	if err := database.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM action_maps WHERE source_session_id = ?", session.ID,
	).Scan(&count); err != nil {
		t.Fatalf("count action maps: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected one stored action map, got %d", count)
	}
}

func testActionMap() actionmap.Map {
	return actionmap.Map{
		SchemaVersion: actionmap.SchemaVersion,
		Site: actionmap.Site{
			Origin:       "https://example.com",
			ObservedURLs: []string{"https://example.com/"},
		},
		Summary: "A catalog page",
		States: []actionmap.State{{
			ID: "catalog", Label: "Catalog", URLPattern: "^https://example.com/",
		}},
		Actions: []actionmap.Action{{
			ID: "search_products", Name: "Search products", Description: "Search the catalog",
			Category: "submit", Status: "observed", Safety: "read", Confidence: 0.9,
			FromState: "catalog",
			Steps: []actionmap.Step{{
				Operation: "wait", Expect: actionmap.Expectation{Kind: "none"}, TimeoutMS: 100,
			}},
			Output: actionmap.Output{Mode: "none", Limit: 10},
		}},
		Privacy: actionmap.Privacy{Policy: "Sensitive values removed"},
	}
}
