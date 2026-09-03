package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/manifest"
)

type RuntimeFeedbackResult struct {
	Applied          bool              `json:"applied"`
	ScopeID          string            `json:"scopeId,omitempty"`
	ActionMap        ActionMapSnapshot `json:"actionMap,omitempty"`
	Confidence       float64           `json:"confidence,omitempty"`
	Health           string            `json:"health,omitempty"`
	SelectorRepaired bool              `json:"selectorRepaired"`
}

func (store *Store) ApplyRunObservationFeedback(
	ctx context.Context,
	observation RunObservation,
) (RuntimeFeedbackResult, error) {
	if observation.Status == "cancelled" {
		return RuntimeFeedbackResult{Applied: false}, nil
	}
	transaction, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("begin runtime feedback transaction: %w", err)
	}
	defer transaction.Rollback()

	var binding CandidateBinding
	var publishedJSON string
	err = transaction.QueryRowContext(ctx, `
		SELECT bindings.scope_id, bindings.action_map_revision, bindings.action_map_digest,
		       publications.published_json
		FROM action_list_publications AS publications
		JOIN action_list_candidate_bindings AS bindings
		  ON bindings.list_id = publications.list_id AND bindings.revision = publications.revision
		WHERE publications.list_id = $1 AND publications.published_digest = $2`,
		observation.ListID, observation.ListDigest,
	).Scan(&binding.ScopeID, &binding.ActionMapRevision, &binding.ActionMapDigest, &publishedJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return RuntimeFeedbackResult{Applied: false}, nil
	}
	if err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("resolve runtime feedback binding: %w", err)
	}
	var feedbackRunID string
	err = transaction.QueryRowContext(ctx, `
		INSERT INTO runtime_feedback_runs (run_id, applied_at)
		VALUES ($1, $2) ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
		observation.RunID, time.Now().UTC(),
	).Scan(&feedbackRunID)
	if errors.Is(err, sql.ErrNoRows) {
		var scopeID, digest, health sql.NullString
		var revision sql.NullInt64
		var confidence sql.NullFloat64
		var repaired sql.NullBool
		lookupErr := transaction.QueryRowContext(ctx, `
			SELECT scope_id, action_map_revision, action_map_digest, confidence, health, selector_repaired
			FROM runtime_feedback_runs WHERE run_id = $1`, observation.RunID).Scan(
			&scopeID, &revision, &digest, &confidence, &health, &repaired,
		)
		if lookupErr != nil || !scopeID.Valid || !revision.Valid || !digest.Valid {
			return RuntimeFeedbackResult{Applied: false}, lookupErr
		}
		if rollbackErr := transaction.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			return RuntimeFeedbackResult{}, fmt.Errorf("close duplicate feedback transaction: %w", rollbackErr)
		}
		snapshot, loadErr := store.GetActionMapRevision(ctx, scopeID.String, int(revision.Int64))
		if loadErr != nil {
			return RuntimeFeedbackResult{}, fmt.Errorf("load applied runtime feedback: %w", loadErr)
		}
		if snapshot.Digest == nil || *snapshot.Digest != digest.String {
			return RuntimeFeedbackResult{}, errors.New("applied runtime feedback digest is inconsistent")
		}
		return RuntimeFeedbackResult{
			Applied: true, ScopeID: scopeID.String, ActionMap: snapshot,
			Confidence: confidence.Float64, Health: health.String,
			SelectorRepaired: repaired.Bool,
		}, nil
	}
	if err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("claim runtime feedback observation: %w", err)
	}

	var scope SiteScope
	var routePatterns string
	var headRevision int
	var headDigest sql.NullString
	var lastLayerSequence int
	if err := transaction.QueryRowContext(ctx, `
		SELECT scope_id, origin, route_patterns_json, head_revision, head_digest, last_layer_sequence
		FROM action_map_scopes WHERE scope_id = $1 FOR UPDATE`, binding.ScopeID).Scan(
		&scope.ScopeID, &scope.Origin, &routePatterns, &headRevision, &headDigest,
		&lastLayerSequence,
	); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("lock runtime feedback scope: %w", err)
	}
	if err := json.Unmarshal([]byte(routePatterns), &scope.RoutePatterns); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("decode runtime feedback scope: %w", err)
	}
	current, metadata, err := loadLockedActionMap(
		ctx, transaction, scope, headRevision, headDigest, lastLayerSequence,
	)
	if err != nil {
		return RuntimeFeedbackResult{}, err
	}

	list, err := manifest.DecodeActionList(json.RawMessage(publishedJSON))
	if err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("decode feedback action list: %w", err)
	}
	var listAction *manifest.Action
	for index := range list.Actions {
		if list.Actions[index].ID == observation.ActionID &&
			list.Actions[index].Version == observation.ActionVersion {
			listAction = &list.Actions[index]
			break
		}
	}
	if listAction == nil {
		return RuntimeFeedbackResult{}, errors.New("run observation action does not match its published list")
	}
	mapActionIndex := -1
	for index := range current.ActionMap.Actions {
		if current.ActionMap.Actions[index].ID == observation.ActionID {
			mapActionIndex = index
			break
		}
	}
	if mapActionIndex < 0 {
		return RuntimeFeedbackResult{}, errors.New("run observation action is absent from the current action map")
	}

	action := current.ActionMap.Actions[mapActionIndex]
	completed, failed, targetFailures, postconditionFailures := 0, 0, 0, 0
	err = transaction.QueryRowContext(ctx, `
		SELECT completed_runs, failed_runs, target_failures, postcondition_failures
		FROM action_runtime_health
		WHERE list_digest = $1 AND action_id = $2 AND action_version = $3`,
		observation.ListDigest, observation.ActionID, observation.ActionVersion,
	).Scan(&completed, &failed, &targetFailures, &postconditionFailures)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return RuntimeFeedbackResult{}, fmt.Errorf("load runtime action health: %w", err)
	}

	adjustment, targetFailure, postconditionFailure := feedbackAdjustment(observation)
	if observation.Status == "completed" {
		completed++
	} else if observation.Status == "failed" {
		failed++
		if targetFailure {
			targetFailures++
		}
		if postconditionFailure {
			postconditionFailures++
		}
	}
	action.Confidence = math.Round(math.Max(0, math.Min(1, action.Confidence+adjustment))*1000) / 1000
	selectorRepaired := false
	if observation.Status == "completed" {
		selectorRepaired = repairActionLocators(&action, *listAction, observation.Steps)
		if action.Status == "unresolved" {
			action.Status = "resolvable"
		}
	}
	health := feedbackHealth(completed, failed, targetFailures, postconditionFailures)
	if health == "quarantined" {
		action.Status = "unresolved"
	}
	action.Evidence = append(action.Evidence, "verification:"+observation.RunID)
	if len(action.Evidence) > 10 {
		action.Evidence = action.Evidence[len(action.Evidence)-10:]
	}
	current.ActionMap.Actions[mapActionIndex] = action
	if err := current.ActionMap.Validate(); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("validate runtime feedback map: %w", err)
	}
	if err := scanStoredMap(current.ActionMap); err != nil {
		return RuntimeFeedbackResult{}, err
	}

	provenance := "observed"
	if observation.Status == "completed" {
		provenance = "verified"
	}
	entityFound := false
	for index := range metadata.Entities {
		if metadata.Entities[index].EntityKind == "action" && metadata.Entities[index].EntityID == action.ID {
			entityFound = true
			if observation.Status == "completed" {
				metadata.Entities[index].Provenance = "verified"
			}
			metadata.Entities[index].EvidenceHandles = sortedUnique(append(
				metadata.Entities[index].EvidenceHandles, observation.RunID,
			))
			if len(metadata.Entities[index].EvidenceHandles) > 32 {
				metadata.Entities[index].EvidenceHandles = metadata.Entities[index].EvidenceHandles[len(metadata.Entities[index].EvidenceHandles)-32:]
			}
		}
	}
	if !entityFound {
		metadata.Entities = append(metadata.Entities, safeEntityMetadata{
			EntityKind: "action", EntityID: action.ID, Provenance: provenance,
			EvidenceHandles: []string{observation.RunID},
		})
	}
	metadata.Evidence = mergeEvidence(metadata.Evidence, []EvidenceCitation{{
		CitationID: "citation_" + observation.RunID,
		EvidenceID: observation.RunID,
		LayerID:    observation.RunID,
		Source:     "verification",
		Kind:       "action",
		Digest:     observation.ListDigest,
	}})
	metadata.Bindings = mergeBindings(metadata.Bindings, []safeEvidenceBinding{{
		EntityKind: "action", EntityID: action.ID, Provenance: provenance,
		LayerSequence: current.SourceLayerSequence, LayerID: observation.RunID,
		EvidenceID: observation.RunID, ContentDigest: observation.ListDigest,
		BindingRole: "verification",
	}})

	digest, documentJSON, err := canonicalMap(current.ActionMap)
	if err != nil {
		return RuntimeFeedbackResult{}, err
	}
	metadataJSON, err := canonicalJSON(metadata)
	if err != nil {
		return RuntimeFeedbackResult{}, err
	}
	now := time.Now().UTC()
	nextRevision := headRevision + 1
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO action_map_revisions
		  (scope_id, revision, digest, source_layer_sequence, schema_version,
		   document_json, evidence_metadata_json, parser_id, parser_version,
		   prompt_version, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'runtime_feedback', '1', 'runtime-feedback/1', $8)`,
		binding.ScopeID, nextRevision, digest, current.SourceLayerSequence,
		current.ActionMap.SchemaVersion, string(documentJSON), string(metadataJSON), now,
	); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("append runtime feedback map: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
		UPDATE action_map_scopes SET head_revision = $1, head_digest = $2, updated_at = $3
		WHERE scope_id = $4`, nextRevision, digest, now, binding.ScopeID,
	); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("advance runtime feedback head: %w", err)
	}
	errorCode := any(nil)
	if observation.ErrorCode != nil {
		errorCode = *observation.ErrorCode
	}
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO action_runtime_health
		  (list_id, list_digest, action_id, action_version, completed_runs, failed_runs,
		   target_failures, postcondition_failures, confidence, status, last_error_code,
		   last_observed_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT (list_digest, action_id, action_version) DO UPDATE SET
		  completed_runs = EXCLUDED.completed_runs, failed_runs = EXCLUDED.failed_runs,
		  target_failures = EXCLUDED.target_failures,
		  postcondition_failures = EXCLUDED.postcondition_failures,
		  confidence = EXCLUDED.confidence, status = EXCLUDED.status,
		  last_error_code = EXCLUDED.last_error_code,
		  last_observed_at = EXCLUDED.last_observed_at`,
		observation.ListID, observation.ListDigest, observation.ActionID,
		observation.ActionVersion, completed, failed, targetFailures,
		postconditionFailures, action.Confidence, health, errorCode, now,
	); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("store runtime action health: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
		UPDATE runtime_feedback_runs
		SET scope_id = $1, action_map_revision = $2, action_map_digest = $3,
		    confidence = $4, health = $5, selector_repaired = $6
		WHERE run_id = $7`, binding.ScopeID, nextRevision, digest,
		action.Confidence, health, selectorRepaired, observation.RunID,
	); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("finalize runtime feedback receipt: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return RuntimeFeedbackResult{}, fmt.Errorf("commit runtime feedback: %w", err)
	}
	current.Revision = nextRevision
	current.Digest = &digest
	current.CreatedAt = &now
	return RuntimeFeedbackResult{
		Applied: true, ScopeID: binding.ScopeID, ActionMap: current,
		Confidence: action.Confidence, Health: health, SelectorRepaired: selectorRepaired,
	}, nil
}

func actionMapLocator(strategy manifest.LocatorStrategy) actionmap.Locator {
	result := actionmap.Locator{}
	switch strategy.Kind {
	case "role":
		result.Role, result.Name = feedbackStringPointer(strategy.Role), feedbackStringPointer(strategy.Name)
	case "placeholder":
		result.Placeholder = feedbackStringPointer(strategy.Text)
	case "href":
		result.HrefContains = feedbackStringPointer(strategy.Contains)
	case "text":
		result.Text = feedbackStringPointer(strategy.Text)
	case "css":
		result.CSS = feedbackStringPointer(strategy.Selector)
	}
	return result
}

func repairActionLocators(action *actionmap.Action, published manifest.Action, observations []ObservationStep) bool {
	repaired := false
	for stepIndex, step := range published.Steps {
		for _, observed := range observations {
			if observed.StepID != step.ID || observed.LocatorStrategyIndex == nil ||
				*observed.LocatorStrategyIndex <= 0 || step.Target == nil ||
				*observed.LocatorStrategyIndex >= len(step.Target.Strategies) ||
				stepIndex >= len(action.Steps) || action.Steps[stepIndex].Operation != step.Operation ||
				!locatorMatchesPublished(action.Steps[stepIndex].Target, *step.Target) {
				continue
			}
			action.Steps[stepIndex].Target = actionMapLocator(step.Target.Strategies[*observed.LocatorStrategyIndex])
			repaired = repaired || action.Steps[stepIndex].Target.HasEvidence()
		}
	}
	return repaired
}

func locatorMatchesPublished(current actionmap.Locator, published manifest.ActionLocator) bool {
	for _, strategy := range published.Strategies {
		if actionMapLocatorsEqual(current, actionMapLocator(strategy)) {
			return true
		}
	}
	return false
}

func actionMapLocatorsEqual(left, right actionmap.Locator) bool {
	return stringPointerEqual(left.CSS, right.CSS) && stringPointerEqual(left.Role, right.Role) &&
		stringPointerEqual(left.Name, right.Name) && stringPointerEqual(left.Placeholder, right.Placeholder) &&
		stringPointerEqual(left.Text, right.Text) && stringPointerEqual(left.HrefContains, right.HrefContains)
}

func stringPointerEqual(left, right *string) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func feedbackStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func feedbackAdjustment(observation RunObservation) (float64, bool, bool) {
	if observation.Status == "completed" {
		return 0.05, false, false
	}
	if observation.Status != "failed" || observation.ErrorCode == nil {
		return 0, false, false
	}
	switch *observation.ErrorCode {
	case "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "TARGET_NOT_INTERACTABLE":
		return -0.2, true, false
	case "POSTCONDITION_FAILED":
		return -0.15, false, true
	default:
		return -0.05, false, false
	}
}

func feedbackHealth(completed, failed, targetFailures, postconditionFailures int) string {
	if targetFailures+postconditionFailures >= 3 && failed > completed {
		return "quarantined"
	}
	if failed > 0 {
		return "degraded"
	}
	return "healthy"
}
