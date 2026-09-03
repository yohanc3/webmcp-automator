package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/api"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/manifest"
	"webmcp-automator/server/internal/store"
)

type fakeDiscoverer struct {
	trace json.RawMessage
}

type failingDiscoverer struct{}

type memoryStore struct {
	mutex        sync.Mutex
	sessions     map[string]store.Session
	discoveries  map[string]store.Discovery
	revisions    map[string]map[int]store.ActionListRevision
	published    map[string]map[int]store.ActionListRevision
	policies     map[string]store.PolicyRecord
	replays      map[string]store.ReplayReport
	observations map[string]store.RunObservation
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		sessions:     map[string]store.Session{},
		discoveries:  map[string]store.Discovery{},
		revisions:    map[string]map[int]store.ActionListRevision{},
		published:    map[string]map[int]store.ActionListRevision{},
		policies:     map[string]store.PolicyRecord{},
		replays:      map[string]store.ReplayReport{},
		observations: map[string]store.RunObservation{},
	}
}

func (database *memoryStore) CreateSession(
	_ context.Context,
	goal string,
	startURL string,
	finalURL string,
	trace json.RawMessage,
) (store.Session, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	session := store.Session{
		ID:        "learn_test",
		Goal:      goal,
		StartURL:  startURL,
		FinalURL:  finalURL,
		Trace:     append(json.RawMessage(nil), trace...),
		Status:    "recorded",
		CreatedAt: time.Now().UTC(),
	}
	database.sessions[session.ID] = session
	return session, nil
}

func (database *memoryStore) MarkLearning(_ context.Context, sessionID string) error {
	return database.setStatus(sessionID, "learning", nil)
}

func (database *memoryStore) MarkFailed(
	_ context.Context,
	sessionID string,
	cause error,
) error {
	message := cause.Error()
	return database.setStatus(sessionID, "failed", &message)
}

func (database *memoryStore) setStatus(sessionID string, status string, failure *string) error {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	session, exists := database.sessions[sessionID]
	if !exists {
		return errors.New("learning session was not found")
	}
	session.Status = status
	session.Error = failure
	database.sessions[sessionID] = session
	return nil
}

func (database *memoryStore) GetSession(
	_ context.Context,
	sessionID string,
) (store.Session, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	session, exists := database.sessions[sessionID]
	if !exists {
		return store.Session{}, errors.New("learning session was not found")
	}
	return session, nil
}

func (database *memoryStore) SaveDiscovery(
	_ context.Context,
	sessionID string,
	result learning.Result,
) (store.Discovery, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	discovery := store.Discovery{
		ID:        "map_test",
		SessionID: sessionID,
		ActionMap: result.ActionMap,
		Model:     result.Model,
		CreatedAt: time.Now().UTC(),
	}
	database.discoveries[sessionID] = discovery
	session := database.sessions[sessionID]
	session.Status = "candidate"
	session.Model = result.Model
	database.sessions[sessionID] = session
	return discovery, nil
}

func (database *memoryStore) GetDiscovery(
	_ context.Context,
	sessionID string,
) (store.Discovery, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	discovery, exists := database.discoveries[sessionID]
	if !exists {
		return store.Discovery{}, errors.New("action map was not found")
	}
	return discovery, nil
}

func (*memoryStore) ListActive(context.Context, string) ([]store.PublishedAdapter, error) {
	return []store.PublishedAdapter{}, nil
}

func (*memoryStore) Publish(context.Context, string, string) error {
	return nil
}

func (*memoryStore) RecordRun(context.Context, store.Run) error {
	return nil
}

func (database *memoryStore) InsertActionListRevision(
	_ context.Context,
	raw json.RawMessage,
) (store.ActionListRevision, error) {
	list, err := manifest.DecodeActionList(raw)
	if err != nil {
		return store.ActionListRevision{}, err
	}
	if list.Publication.Status != "candidate" && list.Publication.Status != "draft" {
		return store.ActionListRevision{}, errors.New("only candidates can be inserted")
	}
	digest, err := manifest.CandidateDigest(raw)
	if err != nil {
		return store.ActionListRevision{}, err
	}
	canonical, err := json.Marshal(list)
	if err != nil {
		return store.ActionListRevision{}, err
	}
	createdAt, _ := time.Parse(time.RFC3339Nano, list.Publication.CreatedAt)
	database.mutex.Lock()
	defer database.mutex.Unlock()
	if database.revisions[list.ListID] == nil {
		database.revisions[list.ListID] = map[int]store.ActionListRevision{}
	}
	if _, exists := database.revisions[list.ListID][list.Publication.Revision]; exists {
		return store.ActionListRevision{}, store.ErrConflict
	}
	revision := store.ActionListRevision{
		ListID: list.ListID, Revision: list.Publication.Revision, Status: "candidate",
		CandidateDigest: digest, Digest: digest, Document: canonical, CreatedAt: createdAt,
	}
	database.revisions[list.ListID][list.Publication.Revision] = revision
	return revision, nil
}

func (database *memoryStore) DiscoverActionLists(
	_ context.Context,
	origin string,
	absoluteURL string,
) ([]store.ActionListRevision, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	result := make([]store.ActionListRevision, 0)
	for _, revisions := range database.published {
		var latest store.ActionListRevision
		for _, revision := range revisions {
			list, err := manifest.DecodeActionList(revision.Document)
			if err != nil {
				return nil, err
			}
			if list.Site.Origin == origin && manifest.MatchesLocation(list, absoluteURL) && revision.Revision > latest.Revision {
				latest = revision
			}
		}
		if latest.Revision > 0 {
			result = append(result, latest)
		}
	}
	return result, nil
}

func (database *memoryStore) GetActionListRevision(
	_ context.Context,
	listID string,
	revision int,
) (store.ActionListRevision, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	if published := database.published[listID][revision]; published.Revision > 0 {
		return published, nil
	}
	if candidate := database.revisions[listID][revision]; candidate.Revision > 0 {
		return candidate, nil
	}
	return store.ActionListRevision{}, store.ErrNotFound
}

func (database *memoryStore) PublishActionList(
	_ context.Context,
	listID string,
	revisionNumber int,
	request store.PublishActionListRequest,
) (store.ActionListRevision, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	candidate := database.revisions[listID][revisionNumber]
	if candidate.Revision == 0 {
		return store.ActionListRevision{}, store.ErrNotFound
	}
	if _, exists := database.published[listID][revisionNumber]; exists {
		return store.ActionListRevision{}, store.ErrConflict
	}
	if request.ExpectedDigest != candidate.CandidateDigest {
		return store.ActionListRevision{}, store.ErrConflict
	}
	policy := database.policies[request.PolicyDecisionID]
	if policy.Decision != "allowed" || policy.ListID != listID || policy.Revision != revisionNumber ||
		policy.CandidateDigest != candidate.CandidateDigest || policy.ExpiresAt != nil && !policy.ExpiresAt.After(time.Now()) {
		return store.ActionListRevision{}, store.ErrGate
	}
	replay := database.replays[request.ReplayReportID]
	if replay.Status != "passed" || replay.ListID != listID || replay.Revision != revisionNumber ||
		replay.CandidateDigest != candidate.CandidateDigest || request.ReviewDecision != "approve" || strings.TrimSpace(request.Reviewer) == "" {
		return store.ActionListRevision{}, store.ErrGate
	}
	list, err := manifest.DecodeActionList(candidate.Document)
	if err != nil {
		return store.ActionListRevision{}, err
	}
	list.Policy.Status = policy.Decision
	list.Policy.Scopes = append([]string(nil), policy.Scopes...)
	list.Policy.CheckedAt = policy.CheckedAt.Format(time.RFC3339Nano)
	if policy.ExpiresAt != nil {
		value := policy.ExpiresAt.Format(time.RFC3339Nano)
		list.Policy.ExpiresAt = &value
	}
	adjusted, _ := json.Marshal(list)
	now := time.Now().UTC()
	for index := range list.Actions {
		reviewedAt := now.Format(time.RFC3339Nano)
		reviewer := request.Reviewer
		list.Actions[index].Provenance.ReviewedAt = &reviewedAt
		list.Actions[index].Provenance.ReviewedBy = &reviewer
	}
	adjusted, _ = json.Marshal(list)
	document, digest, err := manifest.PublishActionList(adjusted, now)
	if err != nil {
		return store.ActionListRevision{}, err
	}
	published := candidate
	published.Status = "published"
	published.Digest = digest
	published.Document = document
	published.PublishedAt = &now
	if database.published[listID] == nil {
		database.published[listID] = map[int]store.ActionListRevision{}
	}
	database.published[listID][revisionNumber] = published
	return published, nil
}

func (database *memoryStore) RecordRunObservation(
	_ context.Context,
	observation store.RunObservation,
) error {
	if err := observation.Validate(); err != nil {
		return err
	}
	database.mutex.Lock()
	defer database.mutex.Unlock()
	eligible := false
	for _, revision := range database.published[observation.ListID] {
		if revision.Digest != observation.ListDigest {
			continue
		}
		list, err := manifest.DecodeActionList(revision.Document)
		if err != nil {
			return err
		}
		for _, action := range list.Actions {
			if action.ID == observation.ActionID && action.Version == observation.ActionVersion {
				eligible = true
			}
		}
	}
	if !eligible {
		return store.ErrNotFound
	}
	if _, exists := database.observations[observation.RunID]; exists {
		return store.ErrConflict
	}
	database.observations[observation.RunID] = observation
	return nil
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

func (failingDiscoverer) Discover(
	_ context.Context,
	_ json.RawMessage,
) (learning.Result, error) {
	return learning.Result{}, context.Canceled
}

func TestHealthReportsPostgres(t *testing.T) {
	database := newMemoryStore()
	server := api.New(database, &fakeDiscoverer{}, false, "openrouter", "fake", "")
	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if body["database"] != "postgres" {
		t.Fatalf("expected postgres health response, got %#v", body)
	}
}

func TestDiscoverSanitizesTraceBeforeStorageAndModel(t *testing.T) {
	database := newMemoryStore()
	discoverer := &fakeDiscoverer{}
	server := api.New(database, discoverer, true, "openrouter", "fake", "")
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
	database := newMemoryStore()
	server := api.New(database, failingDiscoverer{}, true, "openrouter", "fake", "")
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/discover",
		bytes.NewBufferString(`{
			"trace": {
				"schemaVersion":"learning-trace/3",
				"frames":[
					{"sequence":1,"type":"page","page":{"id":"page_1","fingerprint":"home","url":"https://example.com/"}},
					{"sequence":2,"type":"action","fromPageId":"page_1","action":{"id":"action_1","kind":"click"}},
					{"sequence":3,"type":"update","actionId":"action_1","fromPageId":"page_1","toPageId":"page_2","update":{"urlChanged":true}},
					{"sequence":4,"type":"page","page":{"id":"page_2","fingerprint":"results","url":"https://example.com/results"}}
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
	for attempt := 0; attempt < 100; attempt++ {
		stored, getErr := database.GetSession(context.Background(), accepted.SessionID)
		if getErr != nil {
			t.Fatalf("get session: %v", getErr)
		}
		if stored.Status == "failed" {
			if stored.Error == nil || !strings.Contains(*stored.Error, context.Canceled.Error()) {
				t.Fatalf("expected durable context failure, got %#v", stored)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("discovery failure was not persisted")
}

func TestDemoServesTheStorefrontShellForApplicationRoutes(t *testing.T) {
	database := newMemoryStore()
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
	server := api.New(database, &fakeDiscoverer{}, false, "openrouter", "fake", demoDirectory)
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

func ownedStorefrontList(t *testing.T) json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "documentation", "contracts", "examples", "owned-storefront.action-list.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func registryServer(database *memoryStore) *api.Server {
	return api.New(database, &fakeDiscoverer{}, false, "none", "", "")
}

func insertStorefront(t *testing.T, server *api.Server) store.ActionListRevision {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/v1/action-lists", bytes.NewReader(ownedStorefrontList(t)))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("insert action list: got %d: %s", response.Code, response.Body.String())
	}
	var revision store.ActionListRevision
	if err := json.Unmarshal(response.Body.Bytes(), &revision); err != nil {
		t.Fatal(err)
	}
	if response.Header().Get("ETag") != `"`+revision.Digest+`"` {
		t.Fatalf("missing candidate ETag: %v", response.Header())
	}
	return revision
}

func seedPassingGate(database *memoryStore, revision store.ActionListRevision) store.PublishActionListRequest {
	checkedAt := time.Now().UTC()
	database.policies["policy_owned_demo_001"] = store.PolicyRecord{
		ID: "policy_owned_demo_001", ListID: revision.ListID, Revision: revision.Revision,
		CandidateDigest: revision.CandidateDigest, Decision: "allowed",
		Scopes: []string{"learn", "inject", "read", "write"}, CheckedAt: checkedAt,
	}
	database.replays["replay_owned_demo_001"] = store.ReplayReport{
		ID: "replay_owned_demo_001", ListID: revision.ListID, Revision: revision.Revision,
		CandidateDigest: revision.CandidateDigest, Status: "passed", Report: json.RawMessage(`{"summary":"owned fixture passed"}`),
	}
	return store.PublishActionListRequest{
		ExpectedDigest: revision.CandidateDigest, ReviewDecision: "approve", Reviewer: "local-user",
		PolicyDecisionID: "policy_owned_demo_001", ReplayReportID: "replay_owned_demo_001",
	}
}

func publishRequest(t *testing.T, server *api.Server, input store.PublishActionListRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/action-lists/owned_storefront/revisions/1/publish",
		bytes.NewReader(body),
	)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func TestRegistryInsertReviewPublishRetrieveOwnedStorefront(t *testing.T) {
	database := newMemoryStore()
	server := registryServer(database)
	revision := insertStorefront(t, server)

	before := httptest.NewRecorder()
	server.ServeHTTP(before, httptest.NewRequest(
		http.MethodGet,
		"/v1/action-lists?origin=http%3A%2F%2F127.0.0.1%3A4317&url=http%3A%2F%2F127.0.0.1%3A4317%2Fdemo%2F",
		nil,
	))
	if before.Code != http.StatusOK || !strings.Contains(before.Body.String(), `"actionLists":[]`) {
		t.Fatalf("candidate escaped into ready discovery: %d %s", before.Code, before.Body.String())
	}

	gate := seedPassingGate(database, revision)
	publishedResponse := publishRequest(t, server, gate)
	if publishedResponse.Code != http.StatusOK {
		t.Fatalf("publish action list: %d %s", publishedResponse.Code, publishedResponse.Body.String())
	}
	var published store.ActionListRevision
	if err := json.Unmarshal(publishedResponse.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	if published.Status != "published" || published.Digest == revision.CandidateDigest {
		t.Fatalf("unexpected published revision: %#v", published)
	}

	exactRequest := httptest.NewRequest(
		http.MethodGet, "/v1/action-lists/owned_storefront/revisions/1", nil,
	)
	exact := httptest.NewRecorder()
	server.ServeHTTP(exact, exactRequest)
	if exact.Code != http.StatusOK || exact.Header().Get("X-Content-Digest") != published.Digest ||
		!strings.Contains(exact.Body.String(), `"status":"published"`) {
		t.Fatalf("exact published retrieval failed: %d %v %s", exact.Code, exact.Header(), exact.Body.String())
	}
	conditionalRequest := httptest.NewRequest(
		http.MethodGet, "/v1/action-lists/owned_storefront/revisions/1", nil,
	)
	conditionalRequest.Header.Set("If-None-Match", exact.Header().Get("ETag"))
	conditional := httptest.NewRecorder()
	server.ServeHTTP(conditional, conditionalRequest)
	if conditional.Code != http.StatusNotModified || conditional.Body.Len() != 0 {
		t.Fatalf("conditional exact read: %d %s", conditional.Code, conditional.Body.String())
	}

	discovery := httptest.NewRecorder()
	server.ServeHTTP(discovery, httptest.NewRequest(
		http.MethodGet,
		"/v1/action-lists?origin=http%3A%2F%2F127.0.0.1%3A4317&url=http%3A%2F%2F127.0.0.1%3A4317%2Fdemo%2Fsearch%3Fq%3Dheadphones",
		nil,
	))
	if discovery.Code != http.StatusOK || !strings.Contains(discovery.Body.String(), `"listId":"owned_storefront"`) {
		t.Fatalf("published discovery failed: %d %s", discovery.Code, discovery.Body.String())
	}
	conditionalDiscoveryRequest := httptest.NewRequest(
		http.MethodGet,
		"/v1/action-lists?origin=http%3A%2F%2F127.0.0.1%3A4317&url=http%3A%2F%2F127.0.0.1%3A4317%2Fdemo%2Fsearch%3Fq%3Dheadphones",
		nil,
	)
	conditionalDiscoveryRequest.Header.Set("If-None-Match", discovery.Header().Get("ETag"))
	conditionalDiscovery := httptest.NewRecorder()
	server.ServeHTTP(conditionalDiscovery, conditionalDiscoveryRequest)
	if conditionalDiscovery.Code != http.StatusNotModified || conditionalDiscovery.Body.Len() != 0 {
		t.Fatalf("conditional discovery read: %d %s", conditionalDiscovery.Code, conditionalDiscovery.Body.String())
	}
	wrongRoute := httptest.NewRecorder()
	server.ServeHTTP(wrongRoute, httptest.NewRequest(
		http.MethodGet,
		"/v1/action-lists?origin=http%3A%2F%2F127.0.0.1%3A4317&url=http%3A%2F%2F127.0.0.1%3A4317%2Fadmin",
		nil,
	))
	if wrongRoute.Code != http.StatusOK || !strings.Contains(wrongRoute.Body.String(), `"actionLists":[]`) {
		t.Fatalf("wrong route matched: %d %s", wrongRoute.Code, wrongRoute.Body.String())
	}
}

func TestRegistryRevisionsAreAppendOnlyAndExpectedDigestIsCompared(t *testing.T) {
	database := newMemoryStore()
	server := registryServer(database)
	revision := insertStorefront(t, server)
	duplicate := httptest.NewRecorder()
	server.ServeHTTP(duplicate, httptest.NewRequest(
		http.MethodPost, "/v1/action-lists", bytes.NewReader(ownedStorefrontList(t)),
	))
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("expected append-only conflict, got %d: %s", duplicate.Code, duplicate.Body.String())
	}
	gate := seedPassingGate(database, revision)
	gate.ExpectedDigest = "sha256:" + strings.Repeat("0", 64)
	stale := publishRequest(t, server, gate)
	if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), "conflict") {
		t.Fatalf("expected stale digest conflict, got %d: %s", stale.Code, stale.Body.String())
	}
}

func TestRegistryRejectsBlockedPolicyAndFailedReplay(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*memoryStore)
	}{
		{name: "blocked policy", mutate: func(database *memoryStore) {
			policy := database.policies["policy_owned_demo_001"]
			policy.Decision = "denied"
			database.policies[policy.ID] = policy
		}},
		{name: "failed replay", mutate: func(database *memoryStore) {
			replay := database.replays["replay_owned_demo_001"]
			replay.Status = "failed"
			database.replays[replay.ID] = replay
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database := newMemoryStore()
			server := registryServer(database)
			revision := insertStorefront(t, server)
			gate := seedPassingGate(database, revision)
			test.mutate(database)
			response := publishRequest(t, server, gate)
			if response.Code != http.StatusConflict {
				t.Fatalf("expected gate rejection, got %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestConcurrentPublicationHasOneWinner(t *testing.T) {
	database := newMemoryStore()
	server := registryServer(database)
	revision := insertStorefront(t, server)
	gate := seedPassingGate(database, revision)
	statuses := make(chan int, 2)
	var waitGroup sync.WaitGroup
	for range 2 {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			statuses <- publishRequest(t, server, gate).Code
		}()
	}
	waitGroup.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("expected one publication winner, got %#v", counts)
	}
}

func TestRunObservationAcceptsOnlyPrivacySafeTerminalShape(t *testing.T) {
	database := newMemoryStore()
	server := registryServer(database)
	revision := insertStorefront(t, server)
	publishedResponse := publishRequest(t, server, seedPassingGate(database, revision))
	if publishedResponse.Code != http.StatusOK {
		t.Fatalf("publish fixture: %d %s", publishedResponse.Code, publishedResponse.Body.String())
	}
	var published store.ActionListRevision
	if err := json.Unmarshal(publishedResponse.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	unsafe := httptest.NewRecorder()
	server.ServeHTTP(unsafe, httptest.NewRequest(
		http.MethodPost,
		"/v1/run-observations",
		bytes.NewBufferString(`{
			"schemaVersion":"run-observation/1","runId":"run_1","listId":"owned_storefront",
			"listDigest":"`+published.Digest+`",
			"actionId":"search_products","actionVersion":1,
			"startedAt":"2026-09-03T01:00:00Z","finishedAt":"2026-09-03T01:00:01Z",
			"status":"completed","steps":[],"finalStateId":"search_results","errorCode":null,
			"extractedContent":"private page text"
		}`),
	))
	if unsafe.Code != http.StatusBadRequest || !strings.Contains(unsafe.Body.String(), "unknown field") {
		t.Fatalf("unsafe observation was accepted: %d %s", unsafe.Code, unsafe.Body.String())
	}
	safe := httptest.NewRecorder()
	server.ServeHTTP(safe, httptest.NewRequest(
		http.MethodPost,
		"/v1/run-observations",
		bytes.NewBufferString(`{
			"schemaVersion":"run-observation/1","runId":"run_1","listId":"owned_storefront",
			"listDigest":"`+published.Digest+`",
			"actionId":"search_products","actionVersion":1,
			"startedAt":"2026-09-03T01:00:00Z","finishedAt":"2026-09-03T01:00:01Z",
			"status":"completed","steps":[{"stepId":"fill_query","status":"completed","durationMs":18,
			"locatorStrategyIndex":0,"matchCount":1,"postconditionSatisfied":true}],
			"finalStateId":"search_results","errorCode":null
		}`),
	))
	if safe.Code != http.StatusCreated || len(database.observations) != 1 {
		t.Fatalf("safe observation was not recorded: %d %s", safe.Code, safe.Body.String())
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
