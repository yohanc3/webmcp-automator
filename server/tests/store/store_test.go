package store_test

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/store"
)

func TestOpenRequiresPostgresURL(t *testing.T) {
	if _, err := store.Open(""); err == nil || !strings.Contains(err.Error(), "DB_URL") {
		t.Fatalf("expected missing DB_URL error, got %v", err)
	}
	if _, err := store.Open(":memory:"); err == nil || !strings.Contains(err.Error(), "PostgreSQL") {
		t.Fatalf("expected PostgreSQL URL error, got %v", err)
	}
}

func TestGetSessionReadsPostgresRecord(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := store.New(sqlDatabase)
	defer database.Close()

	createdAt := time.Now().UTC().Truncate(time.Microsecond)
	mock.ExpectQuery("SELECT id, goal, start_url, final_url, trace_json, status").
		WithArgs("learn_test").
		WillReturnRows(sqlmock.NewRows([]string{
			"id",
			"goal",
			"start_url",
			"final_url",
			"trace_json",
			"status",
			"model",
			"response_id",
			"error",
			"created_at",
		}).AddRow(
			"learn_test",
			learning.DiscoveryGoal,
			"https://example.com/",
			"https://example.com/results",
			`{"schemaVersion":"learning-trace/3"}`,
			"candidate",
			"openai/gpt-oss-120b",
			"generation_test",
			nil,
			createdAt,
		))

	session, err := database.GetSession(context.Background(), "learn_test")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.ID != "learn_test" || session.Model != "openai/gpt-oss-120b" ||
		!session.CreatedAt.Equal(createdAt) {
		t.Fatalf("unexpected session: %#v", session)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSaveDiscoveryUsesPostgresTransaction(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := store.New(sqlDatabase)
	defer database.Close()

	ctx := context.Background()
	trace := json.RawMessage(`{"schemaVersion":"learning-trace/3"}`)
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO learning_sessions
		  (id, goal, start_url, final_url, trace_json, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'recorded', $6, $7)`)).
		WithArgs(
			sqlmock.AnyArg(),
			learning.DiscoveryGoal,
			"https://example.com/",
			"https://example.com/results",
			string(trace),
			sqlmock.AnyArg(),
			sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	session, err := database.CreateSession(
		ctx,
		learning.DiscoveryGoal,
		"https://example.com/",
		"https://example.com/results",
		trace,
	)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	discovered := testActionMap()
	mapJSON, err := json.Marshal(discovered)
	if err != nil {
		t.Fatal(err)
	}
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO sites").
		WithArgs(sqlmock.AnyArg(), discovered.Site.Origin, sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("site_test"))
	mock.ExpectExec("INSERT INTO action_maps").
		WithArgs(
			sqlmock.AnyArg(),
			"site_test",
			session.ID,
			actionmap.SchemaVersion,
			string(mapJSON),
			"openai/gpt-oss-120b",
			"generation_test",
			sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE learning_sessions").
		WithArgs(
			"site_test",
			"openai/gpt-oss-120b",
			"generation_test",
			sqlmock.AnyArg(),
			session.ID,
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	discovery, err := database.SaveDiscovery(ctx, session.ID, learning.Result{
		ActionMap:  discovered,
		Model:      "openai/gpt-oss-120b",
		ResponseID: "generation_test",
	})
	if err != nil {
		t.Fatalf("save discovery: %v", err)
	}
	if discovery.SessionID != session.ID || discovery.ActionMap.Actions[0].ID != "search_products" {
		t.Fatalf("unexpected discovery: %#v", discovery)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
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
