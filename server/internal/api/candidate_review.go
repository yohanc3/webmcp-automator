package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"webmcp-automator/server/internal/manifest"
	"webmcp-automator/server/internal/store"
)

// CandidateReplayExecutor is deliberately narrow so a real owned-demo actor
// can be injected without giving the review API a browser or network client.
// CI supplies a deterministic executor; the built-in executor validates the
// frozen action-list actor surface only for the owned local demo.
type CandidateReplayExecutor interface {
	Replay(context.Context, manifest.ActionList) (json.RawMessage, error)
}

type reviewStore interface {
	BindCandidate(context.Context, store.CandidateBinding) error
	GetCandidateReviewState(context.Context, string, int) (store.CandidateReviewState, error)
	RecordCandidateRejection(context.Context, string, int, string, string) error
	SavePolicyDecision(context.Context, store.PolicyRecord) error
	SaveReplayReport(context.Context, store.ReplayReport) error
}

type originPolicy struct {
	Origin    string   `json:"origin"`
	Status    string   `json:"status"`
	Scopes    []string `json:"scopes"`
	CheckedAt string   `json:"checkedAt"`
	ExpiresAt *string  `json:"expiresAt"`
}

type candidateDigestRequest struct {
	ExpectedDigest string `json:"expectedDigest"`
}
type materializePolicyRequest struct {
	ExpectedDigest string       `json:"expectedDigest"`
	OriginPolicy   originPolicy `json:"originPolicy"`
}
type candidateReviewRequest struct {
	ExpectedDigest   string `json:"expectedDigest"`
	Decision         string `json:"decision"`
	Reviewer         string `json:"reviewer"`
	PolicyDecisionID string `json:"policyDecisionId"`
	ReplayReportID   string `json:"replayReportId"`
}

type semanticOwnedDemoReplay struct{}

func (semanticOwnedDemoReplay) Replay(_ context.Context, list manifest.ActionList) (json.RawMessage, error) {
	if list.Site.Origin != "http://127.0.0.1:4317" || !strings.HasPrefix(list.ListID, "owned_") {
		return nil, errors.New("deterministic replay is available only for the owned demo")
	}
	for _, action := range list.Actions {
		if len(action.Steps) == 0 {
			return nil, errors.New("candidate has no executable actor steps")
		}
	}
	return json.Marshal(map[string]any{
		"schemaVersion": "candidate-replay/1", "executor": "action-list/1-semantic-owned-demo",
		"privacy": "no page content, arguments, or evidence payloads retained", "status": "passed",
	})
}

func reviewIdentifier(prefix string) string {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UTC().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(bytes)
}

func (server *Server) candidateReviewStore() (reviewStore, bool) {
	database, ok := server.store.(reviewStore)
	return database, ok
}

func (server *Server) verifyCandidateActionMapBinding(ctx context.Context, state store.CandidateReviewState) error {
	if server.actionMaps == nil {
		return errors.New("candidate action-map binding is unavailable")
	}
	mapRevision, err := server.actionMaps.GetActionMapRevision(ctx, state.Binding.ScopeID, state.Binding.ActionMapRevision)
	if err != nil || mapRevision.Digest == nil || *mapRevision.Digest != state.Binding.ActionMapDigest {
		return errors.New("candidate action-map binding is unavailable or stale")
	}
	return nil
}

func (server *Server) candidateState(writer http.ResponseWriter, request *http.Request) {
	database, ok := server.candidateReviewStore()
	if !ok || server.actionMaps == nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "candidate review is unavailable"})
		return
	}
	revision, err := positiveRevision(request.PathValue("revision"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	state, err := database.GetCandidateReviewState(request.Context(), request.PathValue("listID"), revision)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	if err := server.verifyCandidateActionMapBinding(request.Context(), state); err != nil {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "candidate action-map binding is unavailable or stale"})
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (server *Server) materializeCandidatePolicy(writer http.ResponseWriter, request *http.Request) {
	database, ok := server.candidateReviewStore()
	if !ok {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "candidate review is unavailable"})
		return
	}
	revision, err := positiveRevision(request.PathValue("revision"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var input materializePolicyRequest
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	state, err := database.GetCandidateReviewState(request.Context(), request.PathValue("listID"), revision)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	if err := server.verifyCandidateActionMapBinding(request.Context(), state); err != nil {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	candidate, err := server.store.GetActionListRevision(request.Context(), state.Binding.ListID, state.Binding.Revision)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	list, err := manifest.DecodeActionList(candidate.Document)
	if err != nil || input.ExpectedDigest != state.Binding.CandidateDigest || candidate.Status != "candidate" || input.OriginPolicy.Origin != list.Site.Origin {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "candidate digest or origin policy is stale"})
		return
	}
	checkedAt, err := time.Parse(time.RFC3339Nano, input.OriginPolicy.CheckedAt)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "origin policy checkedAt is invalid"})
		return
	}
	decision := "denied"
	if input.OriginPolicy.Status == "allowed" && containsScope(input.OriginPolicy.Scopes, "ambient_learn") {
		decision = "allowed"
	}
	var expiresAt *time.Time
	if input.OriginPolicy.ExpiresAt != nil {
		value, parseErr := time.Parse(time.RFC3339Nano, *input.OriginPolicy.ExpiresAt)
		if parseErr != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "origin policy expiresAt is invalid"})
			return
		}
		expiresAt = &value
		if !value.After(time.Now().UTC()) {
			decision = "denied"
		}
	}
	policy := store.PolicyRecord{ID: reviewIdentifier("policy"), ListID: state.Binding.ListID, Revision: state.Binding.Revision, CandidateDigest: state.Binding.CandidateDigest, Decision: decision, Scopes: []string{"learn", "inject", "read", "write"}, CheckedAt: checkedAt.UTC(), ExpiresAt: expiresAt}
	if err := database.SavePolicyDecision(request.Context(), policy); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "could not materialize candidate policy"})
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{"policyDecision": map[string]any{"id": policy.ID, "status": policy.Decision, "candidateDigest": policy.CandidateDigest}})
}

func (server *Server) replayCandidate(writer http.ResponseWriter, request *http.Request) {
	database, ok := server.candidateReviewStore()
	if !ok {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "candidate review is unavailable"})
		return
	}
	revision, err := positiveRevision(request.PathValue("revision"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var input candidateDigestRequest
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	state, err := database.GetCandidateReviewState(request.Context(), request.PathValue("listID"), revision)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	if err := server.verifyCandidateActionMapBinding(request.Context(), state); err != nil {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	candidate, err := server.store.GetActionListRevision(request.Context(), state.Binding.ListID, state.Binding.Revision)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	if candidate.Status != "candidate" || input.ExpectedDigest != state.Binding.CandidateDigest {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "candidate digest is stale"})
		return
	}
	list, err := manifest.DecodeActionList(candidate.Document)
	if err != nil {
		writeJSON(writer, http.StatusUnprocessableEntity, map[string]string{"error": "candidate document is invalid"})
		return
	}
	reportJSON, replayErr := server.replay.Replay(request.Context(), list)
	status := "passed"
	if replayErr != nil {
		status = "failed"
		reportJSON, _ = json.Marshal(map[string]any{"schemaVersion": "candidate-replay/1", "status": "failed", "reason": "deterministic replay did not pass"})
	}
	report := store.ReplayReport{ID: reviewIdentifier("replay"), ListID: state.Binding.ListID, Revision: state.Binding.Revision, CandidateDigest: state.Binding.CandidateDigest, Status: status, Report: reportJSON}
	if err := database.SaveReplayReport(request.Context(), report); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "could not store replay report"})
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{"replayReport": map[string]any{"id": report.ID, "status": report.Status, "candidateDigest": report.CandidateDigest}})
}

func (server *Server) submitCandidateReview(writer http.ResponseWriter, request *http.Request) {
	database, ok := server.candidateReviewStore()
	if !ok {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "candidate review is unavailable"})
		return
	}
	revision, err := positiveRevision(request.PathValue("revision"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var input candidateReviewRequest
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	state, err := database.GetCandidateReviewState(request.Context(), request.PathValue("listID"), revision)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	if err := server.verifyCandidateActionMapBinding(request.Context(), state); err != nil {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if input.ExpectedDigest != state.Binding.CandidateDigest || strings.TrimSpace(input.Reviewer) == "" {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "candidate digest or reviewer is invalid"})
		return
	}
	if input.Decision == "reject" {
		if err := database.RecordCandidateRejection(request.Context(), state.Binding.ListID, state.Binding.Revision, state.Binding.CandidateDigest, input.Reviewer); err != nil {
			writeRegistryError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"status": "rejected", "published": false})
		return
	}
	if input.Decision != "approve" {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "decision must be approve or reject"})
		return
	}
	published, err := server.store.PublishActionList(request.Context(), state.Binding.ListID, state.Binding.Revision, store.PublishActionListRequest{ExpectedDigest: input.ExpectedDigest, ReviewDecision: "approve", Reviewer: input.Reviewer, PolicyDecisionID: input.PolicyDecisionID, ReplayReportID: input.ReplayReportID})
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, published)
}

func containsScope(scopes []string, wanted string) bool {
	for _, scope := range scopes {
		if scope == wanted {
			return true
		}
	}
	return false
}
