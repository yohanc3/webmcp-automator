package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"webmcp-automator/backend/internal/actionmap"
	"webmcp-automator/backend/internal/learning"
	"webmcp-automator/backend/internal/privacy"
	"webmcp-automator/backend/internal/store"
)

type fakeDiscoverer struct {
	trace json.RawMessage
}

type failingDiscoverer struct{}

func (discoverer *fakeDiscoverer) Discover(
	_ context.Context,
	trace json.RawMessage,
) (learning.Result, error) {
	discoverer.trace = append(json.RawMessage(nil), trace...)
	return learning.Result{
		ActionMap: apiTestMap(),
		Model:     "openai/gpt-oss-120b",
	}, nil
}

func (failingDiscoverer) Discover(
	_ context.Context,
	_ json.RawMessage,
) (learning.Result, error) {
	return learning.Result{}, context.Canceled
}

func TestHealthReportsSQLite(t *testing.T) {
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	server := New(database, &fakeDiscoverer{}, false, "openrouter", "fake", "")
	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if body["database"] != "sqlite" {
		t.Fatalf("expected sqlite health response, got %#v", body)
	}
}

func TestDiscoverSanitizesTraceBeforeStorageAndModel(t *testing.T) {
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	discoverer := &fakeDiscoverer{}
	server := New(database, discoverer, true, "openrouter", "fake", "")
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/discover",
		bytes.NewBufferString(`{
			"trace": {
				"schemaVersion":"learning-trace/3",
				"frames":[
					{"sequence":1,"type":"page","page":{
						"id":"page_1","fingerprint":"home",
						"url":"https://example.com/?account=elijah",
						"semanticXml":"<page>elijah@example.com</page>"
					}},
					{"sequence":2,"type":"action","fromPageId":"page_1","action":{
						"id":"action_1","kind":"fill",
						"value":{"redacted":false,"value":"private"}
					}},
					{"sequence":3,"type":"update","actionId":"action_1",
						"fromPageId":"page_1","toPageId":"page_2","update":{
							"urlChanged":true,
							"afterUrl":"https://example.com/results?q=private"
						}},
					{"sequence":4,"type":"page","page":{
						"id":"page_2","fingerprint":"results",
						"url":"https://example.com/results?q=private"
					}}
				]
			}
		}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	var accepted struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("decode accepted response: %v", err)
	}
	var body struct {
		Status    string          `json:"status"`
		Discovery store.Discovery `json:"discovery"`
	}
	for attempt := 0; attempt < 100; attempt++ {
		statusRequest := httptest.NewRequest(
			http.MethodGet,
			"/api/discover/"+accepted.SessionID,
			nil,
		)
		statusResponse := httptest.NewRecorder()
		server.ServeHTTP(statusResponse, statusRequest)
		if statusResponse.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d: %s", statusResponse.Code, statusResponse.Body.String())
		}
		if err := json.Unmarshal(statusResponse.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode discovery status: %v", err)
		}
		if body.Status == "candidate" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if body.Status != "candidate" {
		t.Fatalf("discovery did not complete: %#v", body)
	}
	session, err := database.GetSession(context.Background(), accepted.SessionID)
	if err != nil {
		t.Fatalf("get stored session: %v", err)
	}
	modelInput := string(session.Trace)
	if strings.Contains(modelInput, "elijah@example.com") || strings.Contains(modelInput, "semanticXml") ||
		strings.Contains(modelInput, "account=") || strings.Contains(modelInput, "?q=") ||
		!strings.Contains(modelInput, "directed_action_graph") {
		t.Fatalf("model received unsanitized trace: %s", modelInput)
	}
	if body.Discovery.ActionMap.Privacy.RedactionsApplied == 0 {
		t.Fatalf("expected persisted privacy summary: %#v", body.Discovery)
	}
}

func TestRunDiscoveryPersistsAContextFailure(t *testing.T) {
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	session, err := database.CreateSession(
		context.Background(),
		learning.DiscoveryGoal,
		"https://example.com/",
		"https://example.com/results",
		json.RawMessage(`{"schemaVersion":"learning-trace/3"}`),
	)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := database.MarkLearning(context.Background(), session.ID); err != nil {
		t.Fatalf("mark learning: %v", err)
	}
	server := New(database, failingDiscoverer{}, true, "openrouter", "fake", "")
	server.runDiscovery(session.ID, session.Trace, privacy.Summary{})
	stored, err := database.GetSession(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if stored.Status != "failed" || stored.Error == nil ||
		!strings.Contains(*stored.Error, context.Canceled.Error()) {
		t.Fatalf("expected durable failed status, got %#v", stored)
	}
}

func TestDemoServesTheStorefrontShellForApplicationRoutes(t *testing.T) {
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	demoDirectory := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(demoDirectory, "index.html"),
		[]byte("<!doctype html><title>Instrument Supply</title>"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(demoDirectory, "app.js"), []byte("'use strict';"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := New(database, &fakeDiscoverer{}, false, "openrouter", "fake", demoDirectory)
	for _, path := range []string{
		"/demo/",
		"/demo/search?q=headphones",
		"/demo/product/field-h1",
		"/demo/compare?product=field-h1&product=reference-h4",
		"/demo/cart",
		"/demo/checkout",
		"/demo/order/confirmed",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Instrument Supply") {
			t.Errorf("expected storefront shell for %s, got %d: %s", path, response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/demo/missing.js", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("expected missing asset to return 404, got %d", response.Code)
	}
}

func apiTestMap() actionmap.Map {
	return actionmap.Map{
		SchemaVersion: actionmap.SchemaVersion,
		Site: actionmap.Site{
			Origin:       "https://example.com",
			ObservedURLs: []string{"https://example.com/"},
		},
		Summary: "A page with readable content",
		States: []actionmap.State{{
			ID: "page", Label: "Page", URLPattern: "^https://example.com/",
		}},
		Actions: []actionmap.Action{{
			ID: "read_page", Name: "Read page", Description: "Read visible page content",
			Category: "read", Status: "observed", Safety: "read", Confidence: 0.8,
			FromState: "page",
			Steps: []actionmap.Step{{
				Operation: "extract", Expect: actionmap.Expectation{Kind: "none"}, TimeoutMS: 100,
			}},
			Output: actionmap.Output{Mode: "page", Limit: 10},
		}},
		Privacy: actionmap.Privacy{Policy: "Model privacy placeholder"},
	}
}
