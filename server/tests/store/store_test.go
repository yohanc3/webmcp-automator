package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/manifest"
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

func storefrontActionList(t *testing.T) json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "documentation", "contracts", "examples", "owned-storefront.action-list.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestInsertActionListRevisionUsesAppendOnlyTransaction(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := store.New(sqlDatabase)
	defer database.Close()
	raw := storefrontActionList(t)
	list, err := manifest.DecodeActionList(raw)
	if err != nil {
		t.Fatal(err)
	}
	canonical, _ := json.Marshal(list)
	digest, _ := manifest.CandidateDigest(raw)
	createdAt, _ := time.Parse(time.RFC3339, list.Publication.CreatedAt)

	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO action_lists").
		WithArgs(list.ListID, list.Site.Origin, createdAt).
		WillReturnRows(sqlmock.NewRows([]string{"origin"}).AddRow(list.Site.Origin))
	mock.ExpectQuery("INSERT INTO action_list_revisions").
		WithArgs(list.ListID, 1, manifest.ActionListSchemaVersion, digest, string(canonical), sqlmock.AnyArg(), createdAt).
		WillReturnRows(sqlmock.NewRows([]string{"revision"}).AddRow(1))
	mock.ExpectCommit()

	revision, err := database.InsertActionListRevision(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if revision.CandidateDigest != digest || revision.Revision != 1 {
		t.Fatalf("unexpected revision: %#v", revision)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPublishActionListTransactionHasOneDatabaseWinner(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := store.New(sqlDatabase)
	defer database.Close()
	raw := storefrontActionList(t)
	list, _ := manifest.DecodeActionList(raw)
	canonical, _ := json.Marshal(list)
	digest, _ := manifest.CandidateDigest(raw)
	createdAt, _ := time.Parse(time.RFC3339, list.Publication.CreatedAt)
	checkedAt := time.Now().UTC().Truncate(time.Microsecond)
	request := store.PublishActionListRequest{
		ExpectedDigest: digest, ReviewDecision: "approve", Reviewer: "local-user",
		PolicyDecisionID: "policy_owned_demo_001", ReplayReportID: "replay_owned_demo_001",
	}

	expectPublish := func(winner bool) {
		mock.ExpectBegin()
		mock.ExpectQuery("SELECT document_json, candidate_digest, created_at").
			WithArgs(list.ListID, 1).
			WillReturnRows(sqlmock.NewRows([]string{"document_json", "candidate_digest", "created_at"}).
				AddRow(string(canonical), digest, createdAt))
		mock.ExpectQuery("SELECT decision").
			WithArgs(list.ListID, 1, digest).
			WillReturnRows(sqlmock.NewRows([]string{"decision"}))
		mock.ExpectQuery("SELECT bindings.candidate_digest").
			WithArgs(list.ListID, 1).
			WillReturnRows(sqlmock.NewRows([]string{"candidate_digest", "scope_id", "action_map_revision", "action_map_digest", "head_revision", "head_digest"}))
		mock.ExpectQuery("SELECT decision, candidate_digest, scopes_json, checked_at, expires_at").
			WithArgs("policy_owned_demo_001", list.ListID, 1).
			WillReturnRows(sqlmock.NewRows([]string{"decision", "candidate_digest", "scopes_json", "checked_at", "expires_at"}).
				AddRow("allowed", digest, `["learn","inject","read","write"]`, checkedAt, nil))
		mock.ExpectQuery("SELECT status, candidate_digest").
			WithArgs("replay_owned_demo_001", list.ListID, 1).
			WillReturnRows(sqlmock.NewRows([]string{"status", "candidate_digest"}).AddRow("passed", digest))
		mock.ExpectExec("INSERT INTO action_list_reviews").
			WithArgs(sqlmock.AnyArg(), list.ListID, 1, digest, "local-user", sqlmock.AnyArg()).
			WillReturnResult(sqlmock.NewResult(0, 1))
		publication := mock.ExpectQuery("INSERT INTO action_list_publications").
			WithArgs(
				sqlmock.AnyArg(), list.ListID, 1, digest, sqlmock.AnyArg(), sqlmock.AnyArg(),
				"policy_owned_demo_001", "replay_owned_demo_001", sqlmock.AnyArg(), sqlmock.AnyArg(),
			)
		if winner {
			publication.WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("publication_1"))
			mock.ExpectCommit()
		} else {
			publication.WillReturnRows(sqlmock.NewRows([]string{"id"}))
			mock.ExpectRollback()
		}
	}

	expectPublish(true)
	published, err := database.PublishActionList(context.Background(), list.ListID, 1, request)
	if err != nil {
		t.Fatalf("first publication: %v", err)
	}
	if published.Status != "published" || manifest.VerifyDigest(published.Document, published.Digest) != nil {
		t.Fatalf("invalid published result: %#v", published)
	}
	expectPublish(false)
	_, err = database.PublishActionList(context.Background(), list.ListID, 1, request)
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected second publisher conflict, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRejectedCandidateDecisionIsTerminalAndIdempotent(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := store.New(sqlDatabase)
	defer database.Close()
	raw := storefrontActionList(t)
	list, _ := manifest.DecodeActionList(raw)
	canonical, _ := json.Marshal(list)
	digest, _ := manifest.CandidateDigest(raw)
	createdAt, _ := time.Parse(time.RFC3339, list.Publication.CreatedAt)

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT candidate_digest").
		WithArgs(list.ListID, 1).
		WillReturnRows(sqlmock.NewRows([]string{"candidate_digest"}).AddRow(digest))
	mock.ExpectQuery("SELECT decision").
		WithArgs(list.ListID, 1, digest).
		WillReturnRows(sqlmock.NewRows([]string{"decision"}))
	mock.ExpectQuery("SELECT EXISTS").
		WithArgs(list.ListID, 1).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec("INSERT INTO action_list_reviews").
		WithArgs(sqlmock.AnyArg(), list.ListID, 1, digest, "local-user", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := database.RecordCandidateRejection(context.Background(), list.ListID, 1, digest, "local-user"); err != nil {
		t.Fatalf("record rejection: %v", err)
	}

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT candidate_digest").
		WithArgs(list.ListID, 1).
		WillReturnRows(sqlmock.NewRows([]string{"candidate_digest"}).AddRow(digest))
	mock.ExpectQuery("SELECT decision").
		WithArgs(list.ListID, 1, digest).
		WillReturnRows(sqlmock.NewRows([]string{"decision"}).AddRow("reject"))
	mock.ExpectRollback()
	if err := database.RecordCandidateRejection(context.Background(), list.ListID, 1, digest, "local-user"); err != nil {
		t.Fatalf("repeat rejection: %v", err)
	}

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT document_json, candidate_digest, created_at").
		WithArgs(list.ListID, 1).
		WillReturnRows(sqlmock.NewRows([]string{"document_json", "candidate_digest", "created_at"}).
			AddRow(string(canonical), digest, createdAt))
	mock.ExpectQuery("SELECT decision").
		WithArgs(list.ListID, 1, digest).
		WillReturnRows(sqlmock.NewRows([]string{"decision"}).AddRow("reject"))
	mock.ExpectRollback()
	_, err = database.PublishActionList(context.Background(), list.ListID, 1, store.PublishActionListRequest{
		ExpectedDigest: digest, ReviewDecision: "approve", Reviewer: "local-user",
		PolicyDecisionID: "policy_owned_demo_001", ReplayReportID: "replay_owned_demo_001",
	})
	if !errors.Is(err, store.ErrGate) {
		t.Fatalf("rejected candidate should not publish, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPublishActionListRejectsAStaleBoundActionMapHead(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := store.New(sqlDatabase)
	defer database.Close()
	raw := storefrontActionList(t)
	list, _ := manifest.DecodeActionList(raw)
	canonical, _ := json.Marshal(list)
	digest, _ := manifest.CandidateDigest(raw)
	createdAt, _ := time.Parse(time.RFC3339, list.Publication.CreatedAt)
	mapDigest := "sha256:" + strings.Repeat("a", 64)
	newHeadDigest := "sha256:" + strings.Repeat("b", 64)

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT document_json, candidate_digest, created_at").
		WithArgs(list.ListID, 1).
		WillReturnRows(sqlmock.NewRows([]string{"document_json", "candidate_digest", "created_at"}).
			AddRow(string(canonical), digest, createdAt))
	mock.ExpectQuery("SELECT decision").
		WithArgs(list.ListID, 1, digest).
		WillReturnRows(sqlmock.NewRows([]string{"decision"}))
	mock.ExpectQuery("SELECT bindings.candidate_digest").
		WithArgs(list.ListID, 1).
		WillReturnRows(sqlmock.NewRows([]string{"candidate_digest", "scope_id", "action_map_revision", "action_map_digest", "head_revision", "head_digest"}).
			AddRow(digest, "site_owned_storefront", 1, mapDigest, 2, newHeadDigest))
	mock.ExpectRollback()
	_, err = database.PublishActionList(context.Background(), list.ListID, 1, store.PublishActionListRequest{
		ExpectedDigest: digest, ReviewDecision: "approve", Reviewer: "local-user",
		PolicyDecisionID: "policy_owned_demo_001", ReplayReportID: "replay_owned_demo_001",
	})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale action-map binding should not publish, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyListActiveProjectsOnlyCanonicalPublishedRegistry(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := store.New(sqlDatabase)
	defer database.Close()
	raw := storefrontActionList(t)
	candidateDigest, _ := manifest.CandidateDigest(raw)
	publishedAt := time.Now().UTC().Truncate(time.Microsecond)
	published, publishedDigest, err := manifest.PublishActionList(raw, publishedAt)
	if err != nil {
		t.Fatal(err)
	}
	createdAt := publishedAt.Add(-time.Minute)
	mock.ExpectQuery("FROM action_list_publications").
		WithArgs("http://127.0.0.1:4317").
		WillReturnRows(sqlmock.NewRows([]string{
			"list_id", "revision", "candidate_digest", "published_digest", "published_json", "created_at", "published_at",
		}).AddRow(
			"owned_storefront", 1, candidateDigest, publishedDigest, string(published), createdAt, publishedAt,
		))
	adapters, err := database.ListActive(context.Background(), "http://127.0.0.1:4317")
	if err != nil {
		t.Fatal(err)
	}
	if len(adapters) != 1 || adapters[0].Manifest.SchemaVersion != manifest.SchemaVersion ||
		adapters[0].Manifest.Validate() != nil {
		t.Fatalf("unexpected legacy projection: %#v", adapters)
	}
	matched := false
	for _, pattern := range adapters[0].Manifest.Site.RoutePatterns {
		compiled, compileErr := regexp.Compile(pattern)
		if compileErr == nil && compiled.MatchString("http://127.0.0.1:4317/demo/search?q=headphones") {
			matched = true
		}
	}
	if !matched {
		t.Fatalf("legacy route projection does not match full URL: %#v", adapters[0].Manifest.Site.RoutePatterns)
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
