package actionmapapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"webmcp-automator/server/internal/store"
)

func TestComposableActionMapHandlers(t *testing.T) {
	database := store.NewMemoryActionMapStore()
	handlers := New(database)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/action-maps/{scopeId}/head", handlers.Head)
	mux.HandleFunc("GET /v1/action-maps/{scopeId}/context", handlers.Context)
	mux.HandleFunc("POST /v1/action-maps/{scopeId}/patches", handlers.ApplyPatch)
	mux.HandleFunc("GET /v1/action-maps/{scopeId}/revisions/{revision}", handlers.Revision)

	input := fixtureApplication(t, "001")
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(
		http.MethodPost, "/v1/action-maps/owned_account_orders/patches", bytes.NewReader(body),
	))
	if response.Code != http.StatusCreated {
		t.Fatalf("unexpected patch response %d: %s", response.Code, response.Body.String())
	}
	expectedETag := `"sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492"`
	if response.Header().Get("ETag") != expectedETag {
		t.Fatalf("unexpected patch ETag: %s", response.Header().Get("ETag"))
	}

	for _, path := range []string{
		"/v1/action-maps/owned_account_orders/head",
		"/v1/action-maps/owned_account_orders/context?revision=1",
		"/v1/action-maps/owned_account_orders/revisions/1",
	} {
		response = httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("unexpected GET response for %s: %d %s", path, response.Code, response.Body.String())
		}
		if response.Header().Get("ETag") != expectedETag {
			t.Fatalf("unexpected GET ETag for %s: %s", path, response.Header().Get("ETag"))
		}
	}
}

func TestPatchHandlerRejectsUnknownFieldsAndScopeMismatch(t *testing.T) {
	database := store.NewMemoryActionMapStore()
	handlers := New(database)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/action-maps/{scopeId}/patches", handlers.ApplyPatch)
	input := fixtureApplication(t, "001")
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body[:len(body)-1], []byte(`,"semanticXmlStored":true}`)...)

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(
		http.MethodPost, "/v1/action-maps/owned_account_orders/patches", bytes.NewReader(body),
	))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field was accepted: %d %s", response.Code, response.Body.String())
	}

	body, _ = json.Marshal(input)
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(
		http.MethodPost, "/v1/action-maps/different_scope/patches", bytes.NewReader(body),
	))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("scope mismatch was accepted: %d %s", response.Code, response.Body.String())
	}
}

func fixtureApplication(t *testing.T, layer string) store.ApplyActionMapRequest {
	t.Helper()
	var request store.AmbientParseRequest
	readFixture(t, "orders.layer-"+layer+".parse-request.json", &request)
	var patch store.ActionMapPatch
	readFixture(t, "orders.layer-"+layer+".patch.json", &patch)
	return store.ApplyActionMapRequest{Request: request, Patch: patch}
}

func readFixture(t *testing.T, name string, target any) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "documentation", "contracts", "examples", name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatal(err)
	}
}
