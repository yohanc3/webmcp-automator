package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

type orderedAmbientParser struct {
	patches  []json.RawMessage
	requests []learning.ParseRequest
	err      error
}

type passingCandidateReplay struct{}

func (passingCandidateReplay) Replay(_ context.Context, list manifest.ActionList) (json.RawMessage, error) {
	actions := make([]map[string]any, 0, len(list.Actions))
	for _, action := range list.Actions {
		actions = append(actions, map[string]any{
			"actionId": action.ID, "actionVersion": action.Version,
			"stepsExecuted": len(action.Steps), "postconditionsVerified": len(action.Steps),
		})
	}
	return json.Marshal(map[string]any{"schemaVersion": "candidate-replay/1", "status": "passed", "actions": actions})
}

type failingCandidateReplay struct{}

func (failingCandidateReplay) Replay(_ context.Context, _ manifest.ActionList) (json.RawMessage, error) {
	return nil, errors.New("owned demo postcondition failed")
}

type unsafeCandidateReplay struct{}

func (unsafeCandidateReplay) Replay(_ context.Context, _ manifest.ActionList) (json.RawMessage, error) {
	return json.RawMessage(`{"schemaVersion":"candidate-replay/1","status":"failed","actions":[],"pageText":"private value"}`), nil
}

type partialCandidateReplay struct{}

func (partialCandidateReplay) Replay(_ context.Context, list manifest.ActionList) (json.RawMessage, error) {
	action := list.Actions[0]
	return json.Marshal(map[string]any{
		"schemaVersion": "candidate-replay/1", "status": "passed",
		"actions": []map[string]any{{
			"actionId": action.ID, "actionVersion": action.Version,
			"stepsExecuted": len(action.Steps), "postconditionsVerified": len(action.Steps),
		}},
	})
}

func (parser *orderedAmbientParser) Discover(context.Context, json.RawMessage) (learning.Result, error) {
	return learning.Result{}, errors.New("unused")
}
func (parser *orderedAmbientParser) Parse(_ context.Context, request learning.ParseRequest) (json.RawMessage, error) {
	parser.requests = append(parser.requests, request)
	if parser.err != nil {
		return nil, parser.err
	}
	if len(parser.patches) == 0 {
		return nil, errors.New("missing deterministic patch")
	}
	raw := parser.patches[0]
	parser.patches = parser.patches[1:]
	var patch map[string]any
	if err := json.Unmarshal(raw, &patch); err != nil {
		return nil, err
	}
	patch["requestId"], patch["idempotencyKey"] = request.RequestID, request.IdempotencyKey
	patch["mapBase"] = map[string]any{"revision": request.MapBase.Revision, "digest": request.MapBase.Digest}
	encoded, err := json.Marshal(patch)
	if err != nil {
		return nil, err
	}
	if _, err := learning.DecodePatch(encoded); err != nil {
		return nil, fmt.Errorf("deterministic patch decode: %w; %s", err, encoded)
	}
	return encoded, nil
}

type memoryStore struct {
	mutex        sync.Mutex
	sessions     map[string]store.Session
	discoveries  map[string]store.Discovery
	revisions    map[string]map[int]store.ActionListRevision
	published    map[string]map[int]store.ActionListRevision
	policies     map[string]store.PolicyRecord
	policyOrder  []string
	replays      map[string]store.ReplayReport
	replayOrder  []string
	reviews      map[string]string
	bindings     map[string]store.CandidateBinding
	observations map[string]store.RunObservation
}

type ambientMemoryStore struct {
	*memoryStore
	*store.MemoryActionMapStore
}

func newAmbientMemoryStore() *ambientMemoryStore {
	return &ambientMemoryStore{memoryStore: newMemoryStore(), MemoryActionMapStore: store.NewMemoryActionMapStore()}
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		sessions:     map[string]store.Session{},
		discoveries:  map[string]store.Discovery{},
		revisions:    map[string]map[int]store.ActionListRevision{},
		published:    map[string]map[int]store.ActionListRevision{},
		policies:     map[string]store.PolicyRecord{},
		replays:      map[string]store.ReplayReport{},
		reviews:      map[string]string{},
		bindings:     map[string]store.CandidateBinding{},
		observations: map[string]store.RunObservation{},
	}
}

func candidateBindingKey(listID string, revision int) string {
	return fmt.Sprintf("%s:%d", listID, revision)
}

func (database *memoryStore) BindCandidate(_ context.Context, binding store.CandidateBinding) error {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	key := candidateBindingKey(binding.ListID, binding.Revision)
	if existing, exists := database.bindings[key]; exists && existing != binding {
		return store.ErrConflict
	}
	database.bindings[key] = binding
	return nil
}

func (database *memoryStore) GetCandidateReviewState(_ context.Context, listID string, revision int) (store.CandidateReviewState, error) {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	binding, exists := database.bindings[candidateBindingKey(listID, revision)]
	if !exists {
		return store.CandidateReviewState{}, store.ErrNotFound
	}
	candidate := database.revisions[listID][revision]
	if candidate.Revision == 0 {
		return store.CandidateReviewState{}, store.ErrNotFound
	}
	status := candidate.Status
	if published := database.published[listID][revision]; published.Revision > 0 {
		status = "published"
	} else if database.reviews[candidateBindingKey(listID, revision)] == "reject" {
		status = "rejected"
	}
	state := store.CandidateReviewState{Binding: binding, Status: status}
	for _, id := range database.policyOrder {
		policy := database.policies[id]
		if policy.ListID == listID && policy.Revision == revision && policy.CandidateDigest == binding.CandidateDigest {
			copy := policy
			state.Policy = &copy
		}
	}
	for _, id := range database.replayOrder {
		replay := database.replays[id]
		if replay.ListID == listID && replay.Revision == revision && replay.CandidateDigest == binding.CandidateDigest {
			copy := replay
			state.ReplayReport = &copy
		}
	}
	return state, nil
}

func (database *memoryStore) SavePolicyDecision(_ context.Context, policy store.PolicyRecord) error {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	if _, exists := database.policies[policy.ID]; exists {
		return store.ErrConflict
	}
	database.policies[policy.ID] = policy
	database.policyOrder = append(database.policyOrder, policy.ID)
	return nil
}

func (database *memoryStore) SaveReplayReport(_ context.Context, replay store.ReplayReport) error {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	if _, exists := database.replays[replay.ID]; exists {
		return store.ErrConflict
	}
	database.replays[replay.ID] = replay
	database.replayOrder = append(database.replayOrder, replay.ID)
	return nil
}

func (database *memoryStore) RecordCandidateRejection(_ context.Context, listID string, revision int, digest, reviewer string) error {
	database.mutex.Lock()
	defer database.mutex.Unlock()
	candidate := database.revisions[listID][revision]
	if candidate.Revision == 0 || candidate.CandidateDigest != digest || strings.TrimSpace(reviewer) == "" || database.published[listID][revision].Revision > 0 {
		return store.ErrGate
	}
	key := candidateBindingKey(listID, revision)
	if database.reviews[key] == "approve" {
		return store.ErrGate
	}
	database.reviews[key] = "reject"
	return nil
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
	key := candidateBindingKey(listID, revisionNumber)
	if database.reviews[key] == "reject" {
		return store.ActionListRevision{}, store.ErrGate
	}
	if database.reviews[key] == "approve" {
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
	if err := manifest.PolicyAllows(list, time.Now().UTC()); err != nil {
		return store.ActionListRevision{}, store.ErrGate
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
	database.reviews[key] = "approve"
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
	database := newAmbientMemoryStore()
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

func TestExtensionMutationsRejectWebpageOriginBeforeBodyParsing(t *testing.T) {
	database := newAmbientMemoryStore()
	server := api.New(database, &fakeDiscoverer{}, false, "openrouter", "fake", "")
	for _, path := range []string{"/v1/ambient/layers", "/v1/action-lists", "/v1/run-observations"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("not json"))
			request.Header.Set("Origin", "https://untrusted.example")
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("expected webpage origin rejection, got %d: %s", response.Code, response.Body.String())
			}
			if response.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("webpage origin received CORS permission: %q", response.Header().Get("Access-Control-Allow-Origin"))
			}
		})
	}
}

func TestAmbientOrdersLifecycleThroughHTTP(t *testing.T) {
	database := newAmbientMemoryStore()
	parser := &orderedAmbientParser{patches: []json.RawMessage{ambientFixture(t, "orders.layer-001.patch.json"), ambientFixture(t, "orders.layer-002.patch.json")}}
	server := api.New(database, parser, false, "fake", "fake", "")
	server.SetCandidateReplayExecutor(passingCandidateReplay{})
	first := ambientLayer(t, "orders.layer-001.parse-request.json")
	firstBody := postAmbient(t, server, first, "chrome-extension://orders-test")
	if firstBody["outcome"] != "applied" {
		t.Fatalf("layer 1 outcome: %#v", firstBody)
	}
	head, err := database.GetActionMapHead(context.Background(), first.SiteScope.ScopeID)
	if err != nil || head.Revision != 1 {
		t.Fatalf("layer 1 head: %#v %v", head, err)
	}
	actionMapPath := "/v1/action-maps/" + first.SiteScope.ScopeID + "/head"
	untrustedMap := httptest.NewRecorder()
	server.ServeHTTP(untrustedMap, httptest.NewRequest(http.MethodGet, actionMapPath, nil))
	if untrustedMap.Code != http.StatusForbidden {
		t.Fatalf("untrusted caller read action map: %d %s", untrustedMap.Code, untrustedMap.Body.String())
	}
	trustedMapRequest := httptest.NewRequest(http.MethodGet, actionMapPath, nil)
	trustedMapRequest.Header.Set("Origin", "chrome-extension://orders-test")
	trustedMapRequest.Header.Set("X-WebMCP-Internal", "ambient-v1")
	trustedMap := httptest.NewRecorder()
	server.ServeHTTP(trustedMap, trustedMapRequest)
	if trustedMap.Code != http.StatusOK || !strings.Contains(trustedMap.Body.String(), `"revision":1`) {
		t.Fatalf("trusted action-map read failed: %d %s", trustedMap.Code, trustedMap.Body.String())
	}
	if _, err := database.GetActionListRevision(context.Background(), learning.AmbientCandidateListID(first.SiteScope.ScopeID), 1); err != nil {
		t.Fatalf("candidate 1: %v", err)
	}
	open := mapAction(head.ActionMap, "open_orders")
	if open == nil || len(open.Steps) == 0 || open.Steps[0].Operation != "click" {
		t.Fatalf("open orders missing executable click: %#v", open)
	}
	if !strings.Contains(strings.Join(open.Evidence, " "), "node_orders_link") {
		t.Fatal("click lacks layer-1 evidence binding")
	}
	second := ambientLayer(t, "orders.layer-002.parse-request.json")
	secondBody := postAmbient(t, server, second, "chrome-extension://orders-test")
	if secondBody["outcome"] != "applied" || secondBody["retryOf"] != nil {
		t.Fatalf("layer 2 outcome: %#v", secondBody)
	}
	head, err = database.GetActionMapHead(context.Background(), second.SiteScope.ScopeID)
	if err != nil || head.Revision != 2 {
		t.Fatalf("layer 2 head: %#v %v", head, err)
	}
	if _, err := database.GetActionListRevision(context.Background(), learning.AmbientCandidateListID(second.SiteScope.ScopeID), 2); err != nil {
		t.Fatalf("candidate 2: %v", err)
	}
	if mapAction(head.ActionMap, "get_recent_orders") == nil || mapAction(head.ActionMap, "get_orders_from_account") == nil {
		t.Fatalf("Orders projection missing: %#v", head.ActionMap.Actions)
	}
	for _, action := range head.ActionMap.Actions {
		if len(action.Steps) == 0 {
			t.Fatalf("zero-step action: %s", action.ID)
		}
	}

	listID := learning.AmbientCandidateListID(second.SiteScope.ScopeID)
	candidate, err := database.GetActionListRevision(context.Background(), listID, 2)
	if err != nil || candidate.CandidateDigest == "" {
		t.Fatalf("exact candidate: %#v %v", candidate, err)
	}
	untrustedState := httptest.NewRecorder()
	server.ServeHTTP(untrustedState, httptest.NewRequest(http.MethodGet, "/v1/action-lists/"+listID+"/revisions/2/candidate-review", nil))
	if untrustedState.Code != http.StatusForbidden {
		t.Fatalf("untrusted caller read candidate review state: %d %s", untrustedState.Code, untrustedState.Body.String())
	}
	state := httptest.NewRecorder()
	stateRequest := httptest.NewRequest(http.MethodGet, "/v1/action-lists/"+listID+"/revisions/2/candidate-review", nil)
	stateRequest.Header.Set("Origin", "chrome-extension://candidate-review-test")
	stateRequest.Header.Set("X-WebMCP-Internal", "ambient-v1")
	server.ServeHTTP(state, stateRequest)
	if state.Code != http.StatusOK || !strings.Contains(state.Body.String(), candidate.CandidateDigest) {
		t.Fatalf("candidate review state: %d %s", state.Code, state.Body.String())
	}

	postReviewJSON := func(path string, value any) *httptest.ResponseRecorder {
		body, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		request.Header.Set("Origin", "chrome-extension://candidate-review-test")
		request.Header.Set("X-WebMCP-Internal", "ambient-v1")
		server.ServeHTTP(response, request)
		return response
	}
	base := "/v1/action-lists/" + listID + "/revisions/2/candidate-review"
	firstCandidate, firstErr := database.GetActionListRevision(context.Background(), listID, 1)
	if firstErr != nil {
		t.Fatal(firstErr)
	}
	if rejected := postReviewJSON("/v1/action-lists/"+listID+"/revisions/1/candidate-review", map[string]any{"expectedDigest": firstCandidate.CandidateDigest, "decision": "reject"}); rejected.Code != http.StatusOK || !strings.Contains(rejected.Body.String(), `"published":false`) {
		t.Fatalf("reject must not publish: %d %s", rejected.Code, rejected.Body.String())
	}
	if rejectedAgain := postReviewJSON("/v1/action-lists/"+listID+"/revisions/1/candidate-review", map[string]any{"expectedDigest": firstCandidate.CandidateDigest, "decision": "reject"}); rejectedAgain.Code != http.StatusOK {
		t.Fatalf("repeat rejection must be idempotent: %d %s", rejectedAgain.Code, rejectedAgain.Body.String())
	}
	if database.published[listID][1].Revision != 0 {
		t.Fatal("rejected candidate was published")
	}
	rejectedPolicy := store.PolicyRecord{
		ID: "policy_rejected_orders_1", ListID: listID, Revision: 1,
		CandidateDigest: firstCandidate.CandidateDigest, Decision: "allowed",
		Scopes: []string{"inject", "read"}, CheckedAt: time.Now().UTC(),
	}
	if err := database.SavePolicyDecision(context.Background(), rejectedPolicy); err != nil {
		t.Fatal(err)
	}
	rejectedReplay := store.ReplayReport{
		ID: "replay_rejected_orders_1", ListID: listID, Revision: 1,
		CandidateDigest: firstCandidate.CandidateDigest, Status: "passed",
		Report: json.RawMessage(`{"summary":"owned fixture passed"}`),
	}
	if err := database.SaveReplayReport(context.Background(), rejectedReplay); err != nil {
		t.Fatal(err)
	}
	if approvedAfterReject := postReviewJSON("/v1/action-lists/"+listID+"/revisions/1/candidate-review", map[string]any{
		"expectedDigest": firstCandidate.CandidateDigest, "decision": "approve",
		"policyDecisionId": rejectedPolicy.ID, "replayReportId": rejectedReplay.ID,
	}); approvedAfterReject.Code != http.StatusConflict {
		t.Fatalf("rejected candidate became publishable: %d %s", approvedAfterReject.Code, approvedAfterReject.Body.String())
	}
	if replayAfterReject := postReviewJSON("/v1/action-lists/"+listID+"/revisions/1/candidate-review/replay", map[string]any{"expectedDigest": firstCandidate.CandidateDigest}); replayAfterReject.Code != http.StatusConflict {
		t.Fatalf("rejected candidate accepted replay: %d %s", replayAfterReject.Code, replayAfterReject.Body.String())
	}
	server.SetCandidateReplayExecutor(unsafeCandidateReplay{})
	if unsafeReplay := postReviewJSON(base+"/replay", map[string]any{"expectedDigest": candidate.CandidateDigest}); unsafeReplay.Code != http.StatusCreated || !strings.Contains(unsafeReplay.Body.String(), `"status":"failed"`) || strings.Contains(unsafeReplay.Body.String(), "private value") {
		t.Fatalf("unsafe replay output escaped sanitization: %d %s", unsafeReplay.Code, unsafeReplay.Body.String())
	}
	for _, storedReplay := range database.replays {
		if strings.Contains(string(storedReplay.Report), "private value") {
			t.Fatalf("unsafe replay output reached storage: %s", storedReplay.Report)
		}
	}
	server.SetCandidateReplayExecutor(partialCandidateReplay{})
	if partialReplay := postReviewJSON(base+"/replay", map[string]any{"expectedDigest": candidate.CandidateDigest}); partialReplay.Code != http.StatusCreated || !strings.Contains(partialReplay.Body.String(), `"status":"failed"`) {
		t.Fatalf("partial replay certified the whole candidate: %d %s", partialReplay.Code, partialReplay.Body.String())
	}
	server.SetCandidateReplayExecutor(failingCandidateReplay{})
	if failed := postReviewJSON(base+"/replay", map[string]any{"expectedDigest": candidate.CandidateDigest}); failed.Code != http.StatusCreated || !strings.Contains(failed.Body.String(), `"status":"failed"`) {
		t.Fatalf("failed replay: %d %s", failed.Code, failed.Body.String())
	}
	server.SetCandidateReplayExecutor(passingCandidateReplay{})
	if stale := postReviewJSON(base+"/replay", map[string]any{"expectedDigest": "sha256:" + strings.Repeat("0", 64)}); stale.Code != http.StatusConflict {
		t.Fatalf("stale replay accepted: %d %s", stale.Code, stale.Body.String())
	}
	denied := postReviewJSON(base+"/policy", map[string]any{"expectedDigest": candidate.CandidateDigest, "originPolicy": map[string]any{"origin": second.SiteScope.Origin, "status": "revoked", "scopes": []string{"ambient_learn"}, "checkedAt": "2026-09-03T12:11:00Z"}})
	if denied.Code != http.StatusCreated || !strings.Contains(denied.Body.String(), `"status":"denied"`) {
		t.Fatalf("denied policy: %d %s", denied.Code, denied.Body.String())
	}
	expired := postReviewJSON(base+"/policy", map[string]any{"expectedDigest": candidate.CandidateDigest, "originPolicy": map[string]any{"origin": second.SiteScope.Origin, "status": "allowed", "scopes": []string{"ambient_learn"}, "checkedAt": "2026-09-03T12:11:00Z", "expiresAt": "2026-09-03T12:11:01Z"}})
	if expired.Code != http.StatusCreated || !strings.Contains(expired.Body.String(), `"status":"denied"`) {
		t.Fatalf("expired policy: %d %s", expired.Code, expired.Body.String())
	}
	if forged := postReviewJSON(base, map[string]any{"expectedDigest": candidate.CandidateDigest, "decision": "approve", "policyDecisionId": "forged", "replayReportId": "forged"}); forged.Code != http.StatusConflict {
		t.Fatalf("forged approve: %d %s", forged.Code, forged.Body.String())
	}
	policy := postReviewJSON(base+"/policy", map[string]any{"expectedDigest": candidate.CandidateDigest, "originPolicy": map[string]any{"origin": second.SiteScope.Origin, "status": "allowed", "scopes": []string{"ambient_learn"}, "checkedAt": "2026-09-03T12:11:01Z"}})
	if policy.Code != http.StatusCreated {
		t.Fatalf("allowed policy: %d %s", policy.Code, policy.Body.String())
	}
	var policyBody struct {
		PolicyDecision struct {
			ID string `json:"id"`
		} `json:"policyDecision"`
	}
	if err := json.Unmarshal(policy.Body.Bytes(), &policyBody); err != nil || policyBody.PolicyDecision.ID == "" {
		t.Fatalf("policy identifier: %v %s", err, policy.Body.String())
	}
	replay := postReviewJSON(base+"/replay", map[string]any{"expectedDigest": candidate.CandidateDigest})
	if replay.Code != http.StatusCreated || !strings.Contains(replay.Body.String(), `"status":"passed"`) {
		t.Fatalf("replay: %d %s", replay.Code, replay.Body.String())
	}
	var replayBody struct {
		ReplayReport struct {
			ID string `json:"id"`
		} `json:"replayReport"`
	}
	if err := json.Unmarshal(replay.Body.Bytes(), &replayBody); err != nil || replayBody.ReplayReport.ID == "" {
		t.Fatalf("replay identifier: %v %s", err, replay.Body.String())
	}
	if ambientConsent := postReviewJSON(base, map[string]any{"expectedDigest": candidate.CandidateDigest, "decision": "approve", "policyDecisionId": policyBody.PolicyDecision.ID, "replayReportId": replayBody.ReplayReport.ID}); ambientConsent.Code != http.StatusConflict {
		t.Fatalf("ambient collection consent authorized execution: %d %s", ambientConsent.Code, ambientConsent.Body.String())
	}
	executionPolicy := store.PolicyRecord{
		ID: "policy_execution_orders_2", ListID: listID, Revision: 2,
		CandidateDigest: candidate.CandidateDigest, Decision: "allowed",
		Scopes: []string{"inject", "read"}, CheckedAt: time.Now().UTC(),
	}
	if err := database.SavePolicyDecision(context.Background(), executionPolicy); err != nil {
		t.Fatal(err)
	}
	currentState := httptest.NewRecorder()
	currentStateRequest := httptest.NewRequest(http.MethodGet, base, nil)
	currentStateRequest.Header.Set("Origin", "chrome-extension://candidate-review-test")
	currentStateRequest.Header.Set("X-WebMCP-Internal", "ambient-v1")
	server.ServeHTTP(currentState, currentStateRequest)
	if currentState.Code != http.StatusOK || !strings.Contains(currentState.Body.String(), executionPolicy.ID) || !strings.Contains(currentState.Body.String(), replayBody.ReplayReport.ID) {
		t.Fatalf("candidate review did not expose latest exact gates: %d %s", currentState.Code, currentState.Body.String())
	}
	bypass := postReviewJSON("/v1/action-lists/"+listID+"/revisions/2/publish", map[string]any{
		"expectedDigest": candidate.CandidateDigest, "reviewDecision": "approve", "reviewer": "untrusted-assertion",
		"policyDecisionId": executionPolicy.ID, "replayReportId": replayBody.ReplayReport.ID,
	})
	if bypass.Code != http.StatusConflict || database.published[listID][2].Revision != 0 {
		t.Fatalf("ambient candidate bypassed candidate review: %d %s", bypass.Code, bypass.Body.String())
	}
	published := postReviewJSON(base, map[string]any{"expectedDigest": candidate.CandidateDigest, "decision": "approve", "policyDecisionId": executionPolicy.ID, "replayReportId": replayBody.ReplayReport.ID})
	if published.Code != http.StatusOK || !strings.Contains(published.Body.String(), `"status":"published"`) {
		t.Fatalf("publication: %d %s", published.Code, published.Body.String())
	}
	if rejectedAfterPublish := postReviewJSON(base, map[string]any{"expectedDigest": candidate.CandidateDigest, "decision": "reject"}); rejectedAfterPublish.Code != http.StatusConflict {
		t.Fatalf("published candidate accepted a rejection: %d %s", rejectedAfterPublish.Code, rejectedAfterPublish.Body.String())
	}
	discovery := httptest.NewRecorder()
	server.ServeHTTP(discovery, httptest.NewRequest(http.MethodGet, "/v1/action-lists?origin=https%3A%2F%2Fshop.example&url=https%3A%2F%2Fshop.example%2Forders", nil))
	if discovery.Code != http.StatusOK || !strings.Contains(discovery.Body.String(), `"listId":"`+listID+`"`) {
		t.Fatalf("published discovery: %d %s", discovery.Code, discovery.Body.String())
	}
}

func TestAmbientProviderFailureIsRetryableAndWebpageIsForbidden(t *testing.T) {
	database := newAmbientMemoryStore()
	parser := &orderedAmbientParser{err: errors.New("provider request failed with status 503")}
	server := api.New(database, parser, false, "fake", "fake", "")
	layer := ambientLayer(t, "orders.layer-001.parse-request.json")
	response := httptest.NewRecorder()
	requestBody, _ := json.Marshal(layer)
	request := httptest.NewRequest(http.MethodPost, "/v1/ambient/layers", bytes.NewReader(requestBody))
	request.Header.Set("Origin", "chrome-extension://orders-test")
	request.Header.Set("X-WebMCP-Internal", "ambient-v1")
	server.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "retryable") {
		t.Fatalf("provider failure: %d %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/v1/ambient/layers", bytes.NewReader(requestBody))
	request.Header.Set("Origin", "https://webpage.example")
	server.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || len(parser.requests) != 1 {
		t.Fatalf("webpage boundary: %d requests=%d", response.Code, len(parser.requests))
	}
}

func ambientFixture(t *testing.T, name string) json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "documentation", "contracts", "examples", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func ambientLayer(t *testing.T, name string) learning.CompletedLayer {
	t.Helper()
	request, err := learning.DecodeParseRequest(ambientFixture(t, name))
	if err != nil {
		t.Fatal(err)
	}
	return learning.CompletedLayer{SiteScope: request.SiteScope, Layer: request.Layer, Observation: request.Observation, Policy: request.Policy, Privacy: request.Privacy}
}
func postAmbient(t *testing.T, server *api.Server, layer learning.CompletedLayer, origin string) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(layer)
	request := httptest.NewRequest(http.MethodPost, "/v1/ambient/layers", bytes.NewReader(raw))
	request.Header.Set("Origin", origin)
	request.Header.Set("X-WebMCP-Internal", "ambient-v1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("ambient POST %d: %s", response.Code, response.Body.String())
	}
	var result map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	return result
}
func mapAction(actionMap actionmap.Map, id string) *actionmap.Action {
	for index := range actionMap.Actions {
		if actionMap.Actions[index].ID == id {
			return &actionMap.Actions[index]
		}
	}
	return nil
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
	request.Header.Set("Origin", "chrome-extension://registry-test")
	request.Header.Set("X-WebMCP-Internal", "ambient-v1")
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
	database.policyOrder = append(database.policyOrder, "policy_owned_demo_001")
	database.replays["replay_owned_demo_001"] = store.ReplayReport{
		ID: "replay_owned_demo_001", ListID: revision.ListID, Revision: revision.Revision,
		CandidateDigest: revision.CandidateDigest, Status: "passed", Report: json.RawMessage(`{"summary":"owned fixture passed"}`),
	}
	database.replayOrder = append(database.replayOrder, "replay_owned_demo_001")
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
	request.Header.Set("Origin", "chrome-extension://registry-test")
	request.Header.Set("X-WebMCP-Internal", "ambient-v1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func TestRegistryInsertReviewPublishRetrieveOwnedStorefront(t *testing.T) {
	database := newMemoryStore()
	server := registryServer(database)
	revision := insertStorefront(t, server)
	untrustedCandidate := httptest.NewRecorder()
	server.ServeHTTP(untrustedCandidate, httptest.NewRequest(
		http.MethodGet, "/v1/action-lists/owned_storefront/revisions/1", nil,
	))
	if untrustedCandidate.Code != http.StatusForbidden {
		t.Fatalf("untrusted caller read an unpublished candidate: %d %s", untrustedCandidate.Code, untrustedCandidate.Body.String())
	}
	trustedCandidateRequest := httptest.NewRequest(
		http.MethodGet, "/v1/action-lists/owned_storefront/revisions/1", nil,
	)
	trustedCandidateRequest.Header.Set("Origin", "chrome-extension://registry-test")
	trustedCandidateRequest.Header.Set("X-WebMCP-Internal", "ambient-v1")
	trustedCandidate := httptest.NewRecorder()
	server.ServeHTTP(trustedCandidate, trustedCandidateRequest)
	if trustedCandidate.Code != http.StatusOK || trustedCandidate.Header().Get("X-Content-Digest") != revision.Digest {
		t.Fatalf("trusted candidate retrieval failed: %d %s", trustedCandidate.Code, trustedCandidate.Body.String())
	}

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
	gate.Reviewer = "untrusted-assertion"
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
	publishedList, err := manifest.DecodeActionList(published.Document)
	if err != nil || publishedList.Actions[0].Provenance.ReviewedBy == nil || *publishedList.Actions[0].Provenance.ReviewedBy != "local-user" {
		t.Fatalf("server did not assign canonical reviewer: %#v %v", publishedList.Actions[0].Provenance.ReviewedBy, err)
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
	duplicateRequest := httptest.NewRequest(
		http.MethodPost, "/v1/action-lists", bytes.NewReader(ownedStorefrontList(t)),
	)
	duplicateRequest.Header.Set("Origin", "chrome-extension://registry-test")
	duplicateRequest.Header.Set("X-WebMCP-Internal", "ambient-v1")
	server.ServeHTTP(duplicate, duplicateRequest)
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
	unsafeRequest := httptest.NewRequest(
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
	)
	unsafeRequest.Header.Set("Origin", "chrome-extension://registry-test")
	unsafeRequest.Header.Set("X-WebMCP-Internal", "ambient-v1")
	server.ServeHTTP(unsafe, unsafeRequest)
	if unsafe.Code != http.StatusBadRequest || !strings.Contains(unsafe.Body.String(), "unknown field") {
		t.Fatalf("unsafe observation was accepted: %d %s", unsafe.Code, unsafe.Body.String())
	}
	safe := httptest.NewRecorder()
	safeRequest := httptest.NewRequest(
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
	)
	safeRequest.Header.Set("Origin", "chrome-extension://registry-test")
	safeRequest.Header.Set("X-WebMCP-Internal", "ambient-v1")
	server.ServeHTTP(safe, safeRequest)
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
