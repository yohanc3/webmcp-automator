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

	"webmcp-automator/backend/internal/actionmap"
	"webmcp-automator/backend/internal/learning"
	"webmcp-automator/backend/internal/store"
)

type fakeDiscoverer struct {
	trace json.RawMessage
}

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
				"initialState": {
					"url": "https://example.com/?account=elijah",
					"semanticXml": "<page>elijah@example.com</page>"
				},
				"finalState": {"url": "https://example.com/results?q=private"},
				"steps": []
			}
		}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", response.Code, response.Body.String())
	}
	modelInput := string(discoverer.trace)
	if strings.Contains(modelInput, "elijah@example.com") || strings.Contains(modelInput, "semanticXml") ||
		strings.Contains(modelInput, "account=") || strings.Contains(modelInput, "?q=") {
		t.Fatalf("model received unsanitized trace: %s", modelInput)
	}
	var body struct {
		Discovery store.Discovery `json:"discovery"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode discovery response: %v", err)
	}
	if body.Discovery.ActionMap.Privacy.RedactionsApplied == 0 {
		t.Fatalf("expected persisted privacy summary: %#v", body.Discovery)
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
