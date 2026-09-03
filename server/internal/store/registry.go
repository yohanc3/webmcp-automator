package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"webmcp-automator/server/internal/manifest"
)

var (
	ErrNotFound = errors.New("action list revision was not found")
	ErrConflict = errors.New("action list registry conflict")
	ErrGate     = errors.New("action list publication gate rejected the request")
)

type ActionListRevision struct {
	ListID          string          `json:"listId"`
	Revision        int             `json:"revision"`
	Status          string          `json:"status"`
	CandidateDigest string          `json:"candidateDigest,omitempty"`
	Digest          string          `json:"digest"`
	Document        json.RawMessage `json:"actionList"`
	CreatedAt       time.Time       `json:"createdAt"`
	PublishedAt     *time.Time      `json:"publishedAt,omitempty"`
}

type PublishActionListRequest struct {
	ExpectedDigest   string `json:"expectedDigest"`
	ReviewDecision   string `json:"reviewDecision"`
	Reviewer         string `json:"reviewer"`
	PolicyDecisionID string `json:"policyDecisionId"`
	ReplayReportID   string `json:"replayReportId"`
}

type PolicyRecord struct {
	ID              string     `json:"id"`
	ListID          string     `json:"listId"`
	Revision        int        `json:"revision"`
	CandidateDigest string     `json:"candidateDigest"`
	Decision        string     `json:"status"`
	Scopes          []string   `json:"scopes"`
	CheckedAt       time.Time  `json:"checkedAt"`
	ExpiresAt       *time.Time `json:"expiresAt"`
}

type ReplayReport struct {
	ID              string          `json:"id"`
	ListID          string          `json:"listId"`
	Revision        int             `json:"revision"`
	CandidateDigest string          `json:"candidateDigest"`
	Status          string          `json:"status"`
	Report          json.RawMessage `json:"report"`
}

// CandidateBinding is server-owned provenance for an ambient projection.  It
// is intentionally not reconstructed from client-visible candidate JSON.
type CandidateBinding struct {
	ListID            string `json:"listId"`
	Revision          int    `json:"revision"`
	CandidateDigest   string `json:"candidateDigest"`
	ScopeID           string `json:"scopeId"`
	ActionMapRevision int    `json:"actionMapRevision"`
	ActionMapDigest   string `json:"actionMapDigest"`
}

type CandidateReviewState struct {
	Binding      CandidateBinding `json:"binding"`
	Status       string           `json:"status"`
	ReplayReport *ReplayReport    `json:"replayReport,omitempty"`
	Policy       *PolicyRecord    `json:"policyDecision,omitempty"`
}

type RunObservation struct {
	SchemaVersion string            `json:"schemaVersion"`
	RunID         string            `json:"runId"`
	ListID        string            `json:"listId"`
	ListDigest    string            `json:"listDigest"`
	ActionID      string            `json:"actionId"`
	ActionVersion int               `json:"actionVersion"`
	StartedAt     string            `json:"startedAt"`
	FinishedAt    string            `json:"finishedAt"`
	Status        string            `json:"status"`
	Steps         []ObservationStep `json:"steps"`
	FinalStateID  *string           `json:"finalStateId"`
	ErrorCode     *string           `json:"errorCode"`
}

type ObservationStep struct {
	StepID                 string `json:"stepId"`
	Status                 string `json:"status"`
	DurationMS             int    `json:"durationMs"`
	LocatorStrategyIndex   *int   `json:"locatorStrategyIndex"`
	MatchCount             *int   `json:"matchCount"`
	PostconditionSatisfied *bool  `json:"postconditionSatisfied"`
}

func (store *Store) InsertActionListRevision(ctx context.Context, raw json.RawMessage) (ActionListRevision, error) {
	list, err := manifest.DecodeActionList(raw)
	if err != nil {
		return ActionListRevision{}, err
	}
	if list.Publication.Status != "candidate" && list.Publication.Status != "draft" {
		return ActionListRevision{}, errors.New("only draft or candidate documents may enter revision storage")
	}
	for _, action := range list.Actions {
		if action.Lifecycle != "candidate" {
			return ActionListRevision{}, errors.New("ingested actions must have candidate lifecycle")
		}
	}
	digest, err := manifest.CandidateDigest(raw)
	if err != nil {
		return ActionListRevision{}, err
	}
	canonical, err := json.Marshal(list)
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("encode action list revision: %w", err)
	}
	createdAt, _ := time.Parse(time.RFC3339Nano, list.Publication.CreatedAt)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("begin action list insertion: %w", err)
	}
	defer transaction.Rollback()

	var storedOrigin string
	if err := transaction.QueryRowContext(ctx, `
		INSERT INTO action_lists (list_id, origin, created_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (list_id) DO UPDATE SET list_id = EXCLUDED.list_id
		RETURNING origin`, list.ListID, list.Site.Origin, createdAt).Scan(&storedOrigin); err != nil {
		return ActionListRevision{}, fmt.Errorf("upsert action list identity: %w", err)
	}
	if storedOrigin != list.Site.Origin {
		return ActionListRevision{}, fmt.Errorf("%w: listId already belongs to a different origin", ErrConflict)
	}
	var inserted int
	if err := transaction.QueryRowContext(ctx, `
		INSERT INTO action_list_revisions
		  (list_id, revision, schema_version, candidate_digest, document_json, source_map_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT DO NOTHING
		RETURNING revision`, list.ListID, list.Publication.Revision, list.SchemaVersion, digest,
		string(canonical), list.Publication.SourceMapID, createdAt).Scan(&inserted); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ActionListRevision{}, fmt.Errorf("%w: revisions are append-only", ErrConflict)
		}
		return ActionListRevision{}, fmt.Errorf("insert action list revision: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return ActionListRevision{}, fmt.Errorf("commit action list revision: %w", err)
	}
	return ActionListRevision{
		ListID: list.ListID, Revision: inserted, Status: list.Publication.Status,
		CandidateDigest: digest, Digest: digest, Document: canonical, CreatedAt: createdAt,
	}, nil
}

func (store *Store) GetActionListRevision(ctx context.Context, listID string, revision int) (ActionListRevision, error) {
	var result ActionListRevision
	var document string
	var publishedAt sql.NullTime
	err := store.db.QueryRowContext(ctx, `
		SELECT r.list_id, r.revision,
		       CASE WHEN p.list_id IS NULL THEN 'candidate' ELSE 'published' END,
		       r.candidate_digest, COALESCE(p.published_digest, r.candidate_digest),
		       COALESCE(p.published_json, r.document_json), r.created_at, p.published_at
		FROM action_list_revisions r
		LEFT JOIN action_list_publications p
		  ON p.list_id = r.list_id AND p.revision = r.revision
		WHERE r.list_id = $1 AND r.revision = $2`, listID, revision).Scan(
		&result.ListID, &result.Revision, &result.Status, &result.CandidateDigest,
		&result.Digest, &document, &result.CreatedAt, &publishedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ActionListRevision{}, ErrNotFound
	}
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("get action list revision: %w", err)
	}
	result.Document = json.RawMessage(document)
	if result.Status == "published" {
		if err := manifest.VerifyDigest(result.Document, result.Digest); err != nil {
			return ActionListRevision{}, fmt.Errorf("validate stored published revision: %w", err)
		}
		value := publishedAt.Time
		result.PublishedAt = &value
	} else {
		actual, err := manifest.CandidateDigest(result.Document)
		if err != nil {
			return ActionListRevision{}, fmt.Errorf("validate stored candidate revision: %w", err)
		}
		if actual != result.CandidateDigest {
			return ActionListRevision{}, errors.New("stored candidate action list digest is invalid")
		}
	}
	return result, nil
}

func (store *Store) DiscoverActionLists(ctx context.Context, origin, absoluteURL string) ([]ActionListRevision, error) {
	if err := exactOrigin(origin); err != nil {
		return nil, err
	}
	if absoluteURL != "" {
		parsed, err := url.Parse(absoluteURL)
		if err != nil || parsed.Scheme+"://"+parsed.Host != origin {
			return nil, errors.New("url must be absolute and have the requested origin")
		}
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT p.list_id, p.revision, r.candidate_digest, p.published_digest,
		       p.published_json, r.created_at, p.published_at
		FROM action_list_publications p
		JOIN action_list_revisions r
		  ON r.list_id = p.list_id AND r.revision = p.revision
		JOIN action_lists l ON l.list_id = p.list_id
		WHERE l.origin = $1
		ORDER BY p.list_id, p.revision DESC`, origin)
	if err != nil {
		return nil, fmt.Errorf("discover published action lists: %w", err)
	}
	defer rows.Close()
	results := make([]ActionListRevision, 0)
	seen := make(map[string]struct{})
	for rows.Next() {
		var result ActionListRevision
		var document string
		var publishedAt time.Time
		if err := rows.Scan(&result.ListID, &result.Revision, &result.CandidateDigest,
			&result.Digest, &document, &result.CreatedAt, &publishedAt); err != nil {
			return nil, fmt.Errorf("scan published action list: %w", err)
		}
		if _, exists := seen[result.ListID]; exists {
			continue
		}
		result.Status = "published"
		result.Document = json.RawMessage(document)
		result.PublishedAt = &publishedAt
		if err := manifest.VerifyDigest(result.Document, result.Digest); err != nil {
			return nil, fmt.Errorf("validate published action list %s: %w", result.ListID, err)
		}
		list, _ := manifest.DecodeActionList(result.Document)
		if manifest.PolicyAllows(list, time.Now().UTC()) != nil {
			continue
		}
		if absoluteURL != "" && !manifest.MatchesLocation(list, absoluteURL) {
			continue
		}
		seen[result.ListID] = struct{}{}
		results = append(results, result)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate published action lists: %w", err)
	}
	return results, nil
}

func (store *Store) SavePolicyDecision(ctx context.Context, decision PolicyRecord) error {
	if !boundedIdentifier(decision.ID, 128) || !boundedIdentifier(decision.ListID, 80) || decision.Revision < 1 ||
		!containsString([]string{"allowed", "denied", "unknown"}, decision.Decision) ||
		!validDigest(decision.CandidateDigest) || decision.CheckedAt.IsZero() || len(decision.Scopes) > 5 {
		return errors.New("policy decision is invalid")
	}
	seenScopes := make(map[string]struct{}, len(decision.Scopes))
	for _, scope := range decision.Scopes {
		if !containsString([]string{"learn", "inject", "read", "write", "danger"}, scope) {
			return errors.New("policy decision contains an invalid scope")
		}
		if _, exists := seenScopes[scope]; exists {
			return errors.New("policy decision contains a duplicate scope")
		}
		seenScopes[scope] = struct{}{}
	}
	scopes, err := json.Marshal(decision.Scopes)
	if err != nil {
		return fmt.Errorf("encode policy scopes: %w", err)
	}
	_, err = store.db.ExecContext(ctx, `
		INSERT INTO policy_decisions
		  (id, list_id, revision, candidate_digest, decision, scopes_json, checked_at, expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, decision.ID, decision.ListID,
		decision.Revision, decision.CandidateDigest, decision.Decision, string(scopes),
		decision.CheckedAt, decision.ExpiresAt, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("save policy decision: %w", err)
	}
	return nil
}

func (store *Store) SaveReplayReport(ctx context.Context, report ReplayReport) error {
	if !boundedIdentifier(report.ID, 128) || !boundedIdentifier(report.ListID, 80) || report.Revision < 1 ||
		!containsString([]string{"passed", "failed"}, report.Status) ||
		!validDigest(report.CandidateDigest) || !json.Valid(report.Report) {
		return errors.New("replay report is invalid")
	}
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO replay_reports
		  (id, list_id, revision, candidate_digest, status, report_json, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, report.ID, report.ListID, report.Revision,
		report.CandidateDigest, report.Status, string(report.Report), time.Now().UTC())
	if err != nil {
		return fmt.Errorf("save replay report: %w", err)
	}
	return nil
}

func (store *Store) BindCandidate(ctx context.Context, binding CandidateBinding) error {
	if !boundedIdentifier(binding.ListID, 80) || !boundedIdentifier(binding.ScopeID, 80) ||
		binding.Revision < 1 || binding.ActionMapRevision < 1 || !validDigest(binding.CandidateDigest) || !validDigest(binding.ActionMapDigest) {
		return errors.New("candidate binding is invalid")
	}
	result, err := store.db.ExecContext(ctx, `
		INSERT INTO action_list_candidate_bindings
		  (list_id, revision, candidate_digest, scope_id, action_map_revision, action_map_digest, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (list_id, revision) DO NOTHING`, binding.ListID, binding.Revision,
		binding.CandidateDigest, binding.ScopeID, binding.ActionMapRevision, binding.ActionMapDigest, time.Now().UTC())
	if err != nil {
		return err
	}
	if inserted, _ := result.RowsAffected(); inserted == 1 {
		return nil
	}
	var existing CandidateBinding
	err = store.db.QueryRowContext(ctx, `
		SELECT candidate_digest, scope_id, action_map_revision, action_map_digest
		FROM action_list_candidate_bindings WHERE list_id = $1 AND revision = $2`, binding.ListID, binding.Revision,
	).Scan(&existing.CandidateDigest, &existing.ScopeID, &existing.ActionMapRevision, &existing.ActionMapDigest)
	if err != nil {
		return err
	}
	if existing.CandidateDigest != binding.CandidateDigest || existing.ScopeID != binding.ScopeID ||
		existing.ActionMapRevision != binding.ActionMapRevision || existing.ActionMapDigest != binding.ActionMapDigest {
		return ErrConflict
	}
	return nil
}

func (store *Store) GetCandidateReviewState(ctx context.Context, listID string, revision int) (CandidateReviewState, error) {
	revisionValue, err := store.GetActionListRevision(ctx, listID, revision)
	if err != nil {
		return CandidateReviewState{}, err
	}
	var result CandidateReviewState
	if err := store.db.QueryRowContext(ctx, `
		SELECT candidate_digest, scope_id, action_map_revision, action_map_digest
		FROM action_list_candidate_bindings
		WHERE list_id = $1 AND revision = $2`, listID, revision).Scan(
		&result.Binding.CandidateDigest, &result.Binding.ScopeID,
		&result.Binding.ActionMapRevision, &result.Binding.ActionMapDigest,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return CandidateReviewState{}, ErrNotFound
		}
		return CandidateReviewState{}, err
	}
	result.Binding.ListID, result.Binding.Revision, result.Status = listID, revision, revisionValue.Status
	if result.Binding.CandidateDigest != revisionValue.CandidateDigest {
		return CandidateReviewState{}, ErrConflict
	}
	var rejected bool
	if err := store.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM action_list_reviews
			WHERE list_id = $1 AND revision = $2 AND candidate_digest = $3 AND decision = 'reject'
		)`, listID, revision, result.Binding.CandidateDigest).Scan(&rejected); err != nil {
		return CandidateReviewState{}, err
	}
	if rejected {
		result.Status = "rejected"
	}
	var scopesJSON string
	policy := PolicyRecord{ListID: listID, Revision: revision, CandidateDigest: result.Binding.CandidateDigest}
	err = store.db.QueryRowContext(ctx, `
		SELECT id, decision, scopes_json, checked_at, expires_at
		FROM policy_decisions
		WHERE list_id = $1 AND revision = $2 AND candidate_digest = $3
		ORDER BY created_at DESC LIMIT 1`, listID, revision, result.Binding.CandidateDigest).
		Scan(&policy.ID, &policy.Decision, &scopesJSON, &policy.CheckedAt, &policy.ExpiresAt)
	if err == nil && json.Unmarshal([]byte(scopesJSON), &policy.Scopes) == nil {
		result.Policy = &policy
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CandidateReviewState{}, err
	}
	replay := ReplayReport{ListID: listID, Revision: revision, CandidateDigest: result.Binding.CandidateDigest}
	err = store.db.QueryRowContext(ctx, `
		SELECT id, status, report_json
		FROM replay_reports
		WHERE list_id = $1 AND revision = $2 AND candidate_digest = $3
		ORDER BY created_at DESC LIMIT 1`, listID, revision, result.Binding.CandidateDigest).
		Scan(&replay.ID, &replay.Status, &replay.Report)
	if err == nil {
		result.ReplayReport = &replay
	} else if !errors.Is(err, sql.ErrNoRows) {
		return CandidateReviewState{}, err
	}
	return result, nil
}

func (store *Store) RecordCandidateRejection(ctx context.Context, listID string, revision int, digest, reviewer string) error {
	if strings.TrimSpace(reviewer) == "" || !validDigest(digest) {
		return errors.New("candidate rejection is invalid")
	}
	transaction, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return fmt.Errorf("begin candidate rejection transaction: %w", err)
	}
	defer transaction.Rollback()

	var candidateDigest string
	if err := transaction.QueryRowContext(ctx, `
		SELECT candidate_digest
		FROM action_list_revisions
		WHERE list_id = $1 AND revision = $2
		FOR UPDATE`, listID, revision).Scan(&candidateDigest); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("lock rejected action list revision: %w", err)
	}
	if candidateDigest != digest {
		return fmt.Errorf("%w: expected digest is stale", ErrConflict)
	}

	var existingDecision string
	err = transaction.QueryRowContext(ctx, `
		SELECT decision
		FROM action_list_reviews
		WHERE list_id = $1 AND revision = $2 AND candidate_digest = $3
		ORDER BY created_at ASC LIMIT 1`, listID, revision, digest).Scan(&existingDecision)
	if err == nil {
		if existingDecision == "reject" {
			return nil
		}
		return fmt.Errorf("%w: candidate already has a terminal review decision", ErrGate)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read candidate review decision: %w", err)
	}

	var published bool
	if err := transaction.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM action_list_publications WHERE list_id = $1 AND revision = $2
		)`, listID, revision).Scan(&published); err != nil {
		return fmt.Errorf("read candidate publication state: %w", err)
	}
	if published {
		return ErrGate
	}
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO action_list_reviews
		  (id, list_id, revision, candidate_digest, decision, reviewer, created_at)
		VALUES ($1, $2, $3, $4, 'reject', $5, $6)`, newID("review"), listID, revision,
		digest, reviewer, time.Now().UTC()); err != nil {
		return fmt.Errorf("record candidate rejection: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit candidate rejection: %w", err)
	}
	return nil
}

func (store *Store) PublishActionList(
	ctx context.Context,
	listID string,
	revision int,
	request PublishActionListRequest,
) (ActionListRevision, error) {
	if request.ReviewDecision != "approve" || strings.TrimSpace(request.Reviewer) == "" ||
		strings.TrimSpace(request.PolicyDecisionID) == "" || strings.TrimSpace(request.ReplayReportID) == "" {
		return ActionListRevision{}, fmt.Errorf("%w: explicit approval, reviewer, policy, and replay are required", ErrGate)
	}
	transaction, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("begin publication transaction: %w", err)
	}
	defer transaction.Rollback()

	var document string
	var candidateDigest string
	var createdAt time.Time
	if err := transaction.QueryRowContext(ctx, `
		SELECT document_json, candidate_digest, created_at
		FROM action_list_revisions
		WHERE list_id = $1 AND revision = $2
		FOR UPDATE`, listID, revision).Scan(&document, &candidateDigest, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ActionListRevision{}, ErrNotFound
		}
		return ActionListRevision{}, fmt.Errorf("lock action list revision: %w", err)
	}
	if request.ExpectedDigest != candidateDigest {
		return ActionListRevision{}, fmt.Errorf("%w: expected digest is stale", ErrConflict)
	}
	actualCandidateDigest, err := manifest.CandidateDigest(json.RawMessage(document))
	if err != nil || actualCandidateDigest != candidateDigest {
		return ActionListRevision{}, fmt.Errorf("%w: stored candidate digest is invalid", ErrGate)
	}
	var existingDecision string
	err = transaction.QueryRowContext(ctx, `
		SELECT decision
		FROM action_list_reviews
		WHERE list_id = $1 AND revision = $2 AND candidate_digest = $3
		ORDER BY created_at ASC LIMIT 1`, listID, revision, candidateDigest).Scan(&existingDecision)
	if err == nil {
		if existingDecision == "reject" {
			return ActionListRevision{}, fmt.Errorf("%w: candidate was rejected", ErrGate)
		}
		return ActionListRevision{}, fmt.Errorf("%w: candidate already has a terminal review decision", ErrConflict)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ActionListRevision{}, fmt.Errorf("read candidate review decision: %w", err)
	}

	var bindingDigest string
	var scopeID string
	var actionMapRevision int
	var actionMapDigest string
	var headRevision int
	var headDigest string
	err = transaction.QueryRowContext(ctx, `
		SELECT bindings.candidate_digest, bindings.scope_id,
		       bindings.action_map_revision, bindings.action_map_digest,
		       scopes.head_revision, scopes.head_digest
		FROM action_list_candidate_bindings AS bindings
		JOIN action_map_scopes AS scopes ON scopes.scope_id = bindings.scope_id
		WHERE bindings.list_id = $1 AND bindings.revision = $2
		FOR SHARE OF scopes`, listID, revision).Scan(
		&bindingDigest, &scopeID, &actionMapRevision, &actionMapDigest, &headRevision, &headDigest,
	)
	if err == nil && (bindingDigest != candidateDigest || scopeID == "" || actionMapRevision != headRevision || actionMapDigest != headDigest) {
		return ActionListRevision{}, fmt.Errorf("%w: candidate action-map binding is no longer current", ErrConflict)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ActionListRevision{}, fmt.Errorf("lock candidate action-map binding: %w", err)
	}

	var policyDecision string
	var policyDigest string
	var scopesJSON string
	var checkedAt time.Time
	var expiresAt sql.NullTime
	if err := transaction.QueryRowContext(ctx, `
		SELECT decision, candidate_digest, scopes_json, checked_at, expires_at
		FROM policy_decisions
		WHERE id = $1 AND list_id = $2 AND revision = $3`, request.PolicyDecisionID, listID, revision).Scan(
		&policyDecision, &policyDigest, &scopesJSON, &checkedAt, &expiresAt,
	); err != nil {
		return ActionListRevision{}, fmt.Errorf("%w: policy decision was not found", ErrGate)
	}
	if policyDecision != "allowed" || policyDigest != candidateDigest ||
		(expiresAt.Valid && !expiresAt.Time.After(time.Now().UTC())) {
		return ActionListRevision{}, fmt.Errorf("%w: policy is blocked, stale, or for another digest", ErrGate)
	}
	var scopes []string
	if err := json.Unmarshal([]byte(scopesJSON), &scopes); err != nil {
		return ActionListRevision{}, fmt.Errorf("decode policy scopes: %w", err)
	}
	list, err := manifest.DecodeActionList(json.RawMessage(document))
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("validate candidate during publication: %w", err)
	}
	list.Policy.Status = policyDecision
	list.Policy.Scopes = scopes
	list.Policy.CheckedAt = checkedAt.UTC().Format(time.RFC3339Nano)
	if expiresAt.Valid {
		value := expiresAt.Time.UTC().Format(time.RFC3339Nano)
		list.Policy.ExpiresAt = &value
	} else {
		list.Policy.ExpiresAt = nil
	}
	if err := manifest.PolicyAllows(list, time.Now().UTC()); err != nil {
		return ActionListRevision{}, fmt.Errorf("%w: %v", ErrGate, err)
	}
	policyAdjusted, err := json.Marshal(list)
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("encode policy-adjusted candidate: %w", err)
	}

	var replayStatus string
	var replayDigest string
	if err := transaction.QueryRowContext(ctx, `
		SELECT status, candidate_digest
		FROM replay_reports
		WHERE id = $1 AND list_id = $2 AND revision = $3`, request.ReplayReportID, listID, revision).Scan(
		&replayStatus, &replayDigest,
	); err != nil {
		return ActionListRevision{}, fmt.Errorf("%w: replay report was not found", ErrGate)
	}
	if replayStatus != "passed" || replayDigest != candidateDigest {
		return ActionListRevision{}, fmt.Errorf("%w: replay did not pass for this digest", ErrGate)
	}

	now := time.Now().UTC()
	for index := range list.Actions {
		reviewedAt := now.Format(time.RFC3339Nano)
		reviewer := request.Reviewer
		list.Actions[index].Provenance.ReviewedAt = &reviewedAt
		list.Actions[index].Provenance.ReviewedBy = &reviewer
	}
	policyAdjusted, err = json.Marshal(list)
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("encode reviewed candidate: %w", err)
	}
	published, publishedDigest, err := manifest.PublishActionList(policyAdjusted, now)
	if err != nil {
		return ActionListRevision{}, fmt.Errorf("prepare published action list: %w", err)
	}
	reviewID := newID("review")
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO action_list_reviews
		  (id, list_id, revision, candidate_digest, decision, reviewer, created_at)
		VALUES ($1, $2, $3, $4, 'approve', $5, $6)`, reviewID, listID, revision,
		candidateDigest, request.Reviewer, now); err != nil {
		return ActionListRevision{}, fmt.Errorf("record action list review: %w", err)
	}
	var publicationID string
	if err := transaction.QueryRowContext(ctx, `
		INSERT INTO action_list_publications
		  (id, list_id, revision, candidate_digest, published_digest, published_json,
		   policy_decision_id, replay_report_id, review_id, published_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (list_id, revision) DO NOTHING
		RETURNING id`, newID("publication"), listID, revision, candidateDigest, publishedDigest,
		string(published), request.PolicyDecisionID, request.ReplayReportID, reviewID, now).Scan(&publicationID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ActionListRevision{}, fmt.Errorf("%w: revision was already published", ErrConflict)
		}
		return ActionListRevision{}, fmt.Errorf("insert action list publication: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return ActionListRevision{}, fmt.Errorf("commit action list publication: %w", err)
	}
	return ActionListRevision{
		ListID: listID, Revision: revision, Status: "published", CandidateDigest: candidateDigest,
		Digest: publishedDigest, Document: published, CreatedAt: createdAt, PublishedAt: &now,
	}, nil
}

func (observation RunObservation) Validate() error {
	if observation.SchemaVersion != "run-observation/1" || !boundedIdentifier(observation.RunID, 128) ||
		!boundedIdentifier(observation.ListID, 80) || !validDigest(observation.ListDigest) ||
		!boundedIdentifier(observation.ActionID, 80) || observation.ActionVersion < 1 ||
		!containsString([]string{"completed", "failed", "cancelled"}, observation.Status) {
		return errors.New("run observation identity or status is invalid")
	}
	if len(observation.Steps) > 32 || observation.Status == "completed" && observation.ErrorCode != nil {
		return errors.New("run observation terminal fields are invalid")
	}
	if observation.ErrorCode != nil && !containsString([]string{
		"POLICY_BLOCKED", "PLAN_NOT_FOUND", "PLAN_VERSION_MISMATCH", "INVALID_ARGUMENTS",
		"PRECONDITION_FAILED", "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "TARGET_NOT_INTERACTABLE",
		"POSTCONDITION_FAILED", "NAVIGATION_OUT_OF_SCOPE", "CONFIRMATION_REQUIRED",
		"CONFIRMATION_DENIED", "CANCELLED", "TIMEOUT", "EXECUTION_TAB_CLOSED",
		"TRANSPORT_DISCONNECTED", "INTERNAL_ERROR",
	}, *observation.ErrorCode) {
		return errors.New("run observation errorCode is invalid")
	}
	startedAt, err := time.Parse(time.RFC3339Nano, observation.StartedAt)
	if err != nil {
		return errors.New("run observation startedAt is invalid")
	}
	finishedAt, err := time.Parse(time.RFC3339Nano, observation.FinishedAt)
	if err != nil || finishedAt.Before(startedAt) {
		return errors.New("run observation finishedAt is invalid")
	}
	for _, step := range observation.Steps {
		if !boundedIdentifier(step.StepID, 80) || !containsString([]string{"completed", "failed", "cancelled"}, step.Status) ||
			step.DurationMS < 0 || step.DurationMS > 300000 || step.MatchCount != nil && *step.MatchCount < 0 ||
			step.LocatorStrategyIndex != nil && *step.LocatorStrategyIndex < 0 {
			return errors.New("run observation contains an invalid step")
		}
	}
	return nil
}

func validDigest(value string) bool {
	if len(value) != len("sha256:")+64 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func boundedIdentifier(value string, maximum int) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			character == '_' || character == '-' || character == '.' {
			continue
		}
		return false
	}
	return value[0] >= 'a' && value[0] <= 'z'
}

func (store *Store) RecordRunObservation(ctx context.Context, observation RunObservation) error {
	if err := observation.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(observation)
	if err != nil {
		return fmt.Errorf("encode run observation: %w", err)
	}
	startedAt, _ := time.Parse(time.RFC3339Nano, observation.StartedAt)
	finishedAt, _ := time.Parse(time.RFC3339Nano, observation.FinishedAt)
	var acceptedRunID string
	err = store.db.QueryRowContext(ctx, `
		INSERT INTO run_observations
		  (run_id, list_id, list_digest, action_id, action_version, status,
		   observation_json, started_at, finished_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id
		WHERE run_observations.observation_json = EXCLUDED.observation_json
		RETURNING run_id`, observation.RunID,
		observation.ListID, observation.ListDigest, observation.ActionID, observation.ActionVersion,
		observation.Status, string(raw), startedAt, finishedAt, time.Now().UTC()).Scan(&acceptedRunID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrConflict
	}
	if err != nil {
		return fmt.Errorf("record run observation: %w", err)
	}
	return nil
}

func exactOrigin(origin string) error {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return errors.New("origin must be an exact HTTP or HTTPS origin")
	}
	return nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
