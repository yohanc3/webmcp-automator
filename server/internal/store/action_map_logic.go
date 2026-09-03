package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"webmcp-automator/server/internal/actionmap"
)

var (
	actionMapIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	ambientIdentifierPattern   = regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,127}$`)
	digestPattern              = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	emailPattern               = regexp.MustCompile(`(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b`)
	longNumberPattern          = regexp.MustCompile(`\b[0-9][0-9 -]{11,}[0-9]\b`)
	argumentTokenPattern       = regexp.MustCompile(`^\{\{arg\.[a-z][a-z0-9_]{0,29}\}\}$`)
	fieldNamePattern           = regexp.MustCompile(`^[a-z][a-z0-9_]{0,29}$`)
)

var completeValidationChecks = []string{
	"request_binding",
	"site_scope",
	"layer_sequence",
	"evidence_resolution",
	"executable_actions",
	"provenance",
	"privacy",
	"action_map_schema",
	"canonical_digest",
}

type materializedRevision struct {
	receipt      ActionMapReceipt
	snapshot     ActionMapSnapshot
	metadata     safeRevisionMetadata
	inputDigest  string
	append       bool
	advanceLayer bool
}

func seedActionMap(scope SiteScope) ActionMapSnapshot {
	return ActionMapSnapshot{
		SiteScopeID: scope.ScopeID,
		Revision:    0,
		Digest:      nil,
		ActionMap: actionmap.Map{
			SchemaVersion: actionmap.SchemaVersion,
			Site: actionmap.Site{
				Origin:       scope.Origin,
				ObservedURLs: []string{},
			},
			Summary:  "Ambient actions for " + scope.ScopeID,
			States:   []actionmap.State{},
			Actions:  []actionmap.Action{},
			Warnings: []string{},
			Privacy: actionmap.Privacy{
				RedactionsApplied: 0,
				Categories:        []string{},
				Policy:            "Policy-gated semantic sanitization before model transfer.",
			},
		},
	}
}

func prepareActionMapApplication(
	input ApplyActionMapRequest,
	current ActionMapSnapshot,
	metadata safeRevisionMetadata,
	now time.Time,
) materializedRevision {
	base := pointerFromBase(input.Patch.MapBase)
	currentPointer := pointerFromSnapshot(current)
	receipt := baseReceipt(input, base, currentPointer, now)
	inputDigest, err := applicationInputDigest(input)
	if err != nil {
		return rejectedMaterialization(receipt, "VALIDATION_FAILED", current, metadata, "")
	}
	if err := validateApplicationInput(input, current, metadata); err != nil {
		return rejectedMaterialization(receipt, "VALIDATION_FAILED", current, metadata, inputDigest)
	}
	if input.Patch.MapBase.Revision != current.Revision {
		return conflictMaterialization(receipt, "BASE_REVISION_STALE", current, metadata, inputDigest)
	}
	if !equalDigest(input.Patch.MapBase.Digest, current.Digest) {
		return conflictMaterialization(receipt, "BASE_DIGEST_MISMATCH", current, metadata, inputDigest)
	}
	if input.Request.MapBase.PreviousLayerSequence != current.SourceLayerSequence ||
		input.Request.Layer.Sequence <= current.SourceLayerSequence {
		return conflictMaterialization(receipt, "LAYER_SEQUENCE_STALE", current, metadata, inputDigest)
	}

	if input.Patch.Decision == "no_change" {
		result := currentPointer
		receipt.Application.Status = "no_change"
		receipt.Application.Result = &result
		receipt.Validation.Checks = append([]string(nil), completeValidationChecks...)
		receipt.Storage.SafeEvidenceMetadataCount = len(input.Patch.EvidenceCitations)
		return materializedRevision{
			receipt: receipt, snapshot: current, metadata: metadata,
			inputDigest: inputDigest, advanceLayer: true,
		}
	}

	nextMap, nextMetadata, err := applyPatch(input, current.ActionMap, metadata)
	if err != nil {
		return rejectedMaterialization(receipt, "VALIDATION_FAILED", current, metadata, inputDigest)
	}
	digest, canonical, err := canonicalMap(nextMap)
	if err != nil || len(canonical) == 0 {
		return rejectedMaterialization(receipt, "VALIDATION_FAILED", current, metadata, inputDigest)
	}
	nextDigest := digest
	createdAt := now.UTC()
	next := ActionMapSnapshot{
		SiteScopeID:         current.SiteScopeID,
		Revision:            current.Revision + 1,
		Digest:              &nextDigest,
		SourceLayerSequence: input.Request.Layer.Sequence,
		ActionMap:           nextMap,
		CreatedAt:           &createdAt,
	}
	result := pointerFromSnapshot(next)
	receipt.Application.Status = "applied"
	receipt.Application.Result = &result
	receipt.Application.Current = result
	receipt.Validation.Checks = append([]string(nil), completeValidationChecks...)
	receipt.Storage.ActionMapRevisionStored = true
	receipt.Storage.SafeEvidenceMetadataCount = len(input.Patch.EvidenceCitations)
	return materializedRevision{
		receipt: receipt, snapshot: next, metadata: nextMetadata,
		inputDigest: inputDigest, append: true, advanceLayer: true,
	}
}

func baseReceipt(
	input ApplyActionMapRequest,
	base RevisionPointer,
	current RevisionPointer,
	now time.Time,
) ActionMapReceipt {
	return ActionMapReceipt{
		SchemaVersion:       ActionMapRevisionSchemaVersion,
		RequestID:           input.Request.RequestID,
		PatchID:             input.Patch.PatchID,
		IdempotencyKey:      input.Request.IdempotencyKey,
		SiteScopeID:         input.Request.SiteScope.ScopeID,
		SourceLayerSequence: input.Request.Layer.Sequence,
		Application: RevisionApplication{
			Status:  "rejected",
			Base:    base,
			Current: current,
		},
		Parser: ParserIdentity{
			ParserID:      input.Patch.Parser.ParserID,
			ParserVersion: input.Patch.Parser.ParserVersion,
			PromptVersion: input.Patch.Parser.PromptVersion,
		},
		Validation: RevisionValidation{
			ValidatorVersion:        AmbientValidatorVersion,
			ActionMapSchemaVersion:  actionmap.SchemaVersion,
			ActionListSchemaVersion: "action-list/1",
			Checks:                  []string{"request_binding"},
		},
		Storage:   RevisionStorage{},
		AppliedAt: now.UTC(),
	}
}

func rejectedMaterialization(
	receipt ActionMapReceipt,
	code string,
	current ActionMapSnapshot,
	metadata safeRevisionMetadata,
	inputDigest string,
) materializedRevision {
	receipt.Application.Status = "rejected"
	receipt.Application.Result = nil
	receipt.Application.Current = pointerFromSnapshot(current)
	receipt.Application.ConflictCode = &code
	return materializedRevision{
		receipt: receipt, snapshot: current, metadata: metadata, inputDigest: inputDigest,
	}
}

func conflictMaterialization(
	receipt ActionMapReceipt,
	code string,
	current ActionMapSnapshot,
	metadata safeRevisionMetadata,
	inputDigest string,
) materializedRevision {
	receipt.Application.Status = "conflict"
	receipt.Application.Result = nil
	receipt.Application.Current = pointerFromSnapshot(current)
	receipt.Application.ConflictCode = &code
	return materializedRevision{
		receipt: receipt, snapshot: current, metadata: metadata, inputDigest: inputDigest,
	}
}

func reusedKeyReceipt(input ApplyActionMapRequest, current ActionMapSnapshot, now time.Time) ActionMapReceipt {
	receipt := baseReceipt(input, pointerFromBase(input.Patch.MapBase), pointerFromSnapshot(current), now)
	code := "IDEMPOTENCY_KEY_REUSED"
	receipt.Application.ConflictCode = &code
	return receipt
}

func duplicateReceipt(original ActionMapReceipt) ActionMapReceipt {
	if original.Application.Status != "applied" && original.Application.Status != "no_change" {
		return original
	}
	duplicate := original
	duplicate.Application.Status = "duplicate"
	duplicate.Storage.ActionMapRevisionStored = false
	return duplicate
}

func validateApplicationInput(
	input ApplyActionMapRequest,
	current ActionMapSnapshot,
	metadata safeRevisionMetadata,
) error {
	request := input.Request
	patch := input.Patch
	if request.SchemaVersion != AmbientParseSchemaVersion || patch.SchemaVersion != ActionMapPatchSchemaVersion {
		return errors.New("unsupported ambient schema version")
	}
	if !ambientIdentifierPattern.MatchString(request.RequestID) ||
		!ambientIdentifierPattern.MatchString(request.SiteScope.ScopeID) ||
		!ambientIdentifierPattern.MatchString(request.Layer.LayerID) ||
		!ambientIdentifierPattern.MatchString(patch.PatchID) {
		return errors.New("invalid request identifier")
	}
	if request.Attempt < 1 || request.Attempt > 20 || request.Layer.Sequence < 1 {
		return errors.New("invalid request sequence")
	}
	if err := validateAmbientRequestShape(request); err != nil {
		return err
	}
	if patch.RequestID != request.RequestID || patch.IdempotencyKey != request.IdempotencyKey ||
		patch.SiteScopeID != request.SiteScope.ScopeID || patch.LayerSequence != request.Layer.Sequence ||
		patch.MapBase.Revision != request.MapBase.Revision ||
		!equalDigest(patch.MapBase.Digest, request.MapBase.Digest) ||
		patch.Parser.ParserID != request.Parser.ParserID ||
		patch.Parser.ParserVersion != request.Parser.ParserVersion ||
		patch.Parser.PromptVersion != request.Parser.PromptVersion {
		return errors.New("patch is not bound to the exact request")
	}
	if request.Parser.OutputSchemaVersion != ActionMapPatchSchemaVersion ||
		request.Policy.Status != "allowed" || request.Policy.Scope != "ambient_learn" ||
		request.Privacy.RawPersisted || request.Privacy.RedactionCount < 0 {
		return errors.New("request policy or privacy contract is invalid")
	}
	if !digestPattern.MatchString(request.IdempotencyKey) ||
		!digestPattern.MatchString(request.Layer.SemanticXMLDigest) ||
		!digestPattern.MatchString(request.Privacy.RedactionDigest) {
		return errors.New("request digest is invalid")
	}
	xmlDigest := digestBytes([]byte(request.Layer.SemanticXML))
	if xmlDigest != request.Layer.SemanticXMLDigest || request.Layer.SemanticXMLVersion != "semantic-ui/2" {
		return errors.New("semantic XML digest is invalid")
	}
	expectedKey, err := ambientIdempotencyDigest(request)
	if err != nil || expectedKey != request.IdempotencyKey {
		return errors.New("idempotency key does not match its canonical tuple")
	}
	if err := validateScope(request.SiteScope, request.Layer.URL); err != nil {
		return err
	}
	if current.Revision > 0 && current.ActionMap.Site.Origin != request.SiteScope.Origin {
		return errors.New("site scope origin changed")
	}
	if err := validatePatchShape(patch); err != nil {
		return err
	}
	if err := validateEvidence(input, metadata); err != nil {
		return err
	}
	if err := validateVerifiedSemantics(input, current); err != nil {
		return err
	}
	return nil
}

func validateAmbientRequestShape(request AmbientParseRequest) error {
	if err := validatePointer(request.MapBase.Revision, request.MapBase.Digest); err != nil {
		return err
	}
	if (request.MapBase.Revision == 0 && request.MapBase.PreviousLayerSequence != 0) ||
		(request.MapBase.Revision > 0 && request.MapBase.PreviousLayerSequence < 1) {
		return errors.New("request map base layer sequence is invalid")
	}
	if _, err := time.Parse(time.RFC3339, request.Layer.CompletedAt); err != nil {
		return errors.New("layer completion time is invalid")
	}
	if _, err := time.Parse(time.RFC3339, request.Policy.CheckedAt); err != nil {
		return errors.New("policy check time is invalid")
	}
	if !oneOfString(request.Layer.CompletionReason,
		"initial_document", "user_effect", "navigation", "same_document_route") ||
		len(request.Layer.SemanticXML) == 0 || len(request.Layer.SemanticXML) > 500000 ||
		len(request.Layer.EvidenceIDs) == 0 || len(request.Layer.EvidenceIDs) > 5000 ||
		!uniqueStrings(request.Layer.EvidenceIDs) || !validUTF8Strings(request.Layer.EvidenceIDs) {
		return errors.New("semantic layer shape is invalid")
	}
	for _, evidenceID := range request.Layer.EvidenceIDs {
		if !ambientIdentifierPattern.MatchString(evidenceID) {
			return errors.New("semantic layer evidence identifier is invalid")
		}
	}
	if request.Observation == nil {
		if request.Layer.Sequence != 1 || request.Layer.CompletionReason != "initial_document" {
			return errors.New("only the initial layer may omit an observation")
		}
	} else if err := validateObservation(*request.Observation, request.Layer); err != nil {
		return err
	}
	if strings.TrimSpace(request.Parser.ParserID) == "" ||
		!ambientIdentifierPattern.MatchString(request.Parser.ParserID) ||
		strings.TrimSpace(request.Parser.ParserVersion) == "" ||
		len(request.Parser.ParserVersion) > 100 ||
		strings.TrimSpace(request.Parser.PromptVersion) == "" ||
		len(request.Parser.PromptVersion) > 100 ||
		strings.TrimSpace(request.Privacy.SanitizerVersion) == "" ||
		len(request.Privacy.SanitizerVersion) > 100 ||
		!ambientIdentifierPattern.MatchString(request.Policy.DecisionID) ||
		len(request.Privacy.Categories) > 32 || !uniqueStrings(request.Privacy.Categories) {
		return errors.New("parser, policy, or privacy metadata is invalid")
	}
	for _, category := range request.Privacy.Categories {
		if strings.TrimSpace(category) == "" || len(category) > 100 {
			return errors.New("privacy category is invalid")
		}
	}
	if err := validateCompactContext(request.Context); err != nil {
		return err
	}
	return nil
}

func validateObservation(observation AmbientObservation, layer SemanticLayer) error {
	if !ambientIdentifierPattern.MatchString(observation.ObservationID) ||
		!ambientIdentifierPattern.MatchString(observation.FromLayerID) || observation.EventSequence < 1 ||
		!oneOfString(observation.Kind, "click", "fill", "press", "submit", "navigate", "other") ||
		!oneOfString(observation.Outcome.Kind,
			"semantic_update", "navigation", "same_document_route", "no_visible_change") ||
		len(observation.ArgumentTokens) > 16 || !uniqueStrings(observation.ArgumentTokens) ||
		len(observation.Outcome.EvidenceIDs) == 0 || len(observation.Outcome.EvidenceIDs) > 64 ||
		!uniqueStrings(observation.Outcome.EvidenceIDs) {
		return errors.New("observation shape is invalid")
	}
	if observation.TargetEvidenceID != nil &&
		!ambientIdentifierPattern.MatchString(*observation.TargetEvidenceID) {
		return errors.New("observation target evidence is invalid")
	}
	for _, token := range observation.ArgumentTokens {
		if !argumentTokenPattern.MatchString(token) {
			return errors.New("observation argument token is invalid")
		}
	}
	for _, evidenceID := range observation.Outcome.EvidenceIDs {
		if !ambientIdentifierPattern.MatchString(evidenceID) {
			return errors.New("observation outcome evidence is invalid")
		}
	}
	if layer.Sequence <= 1 || observation.FromLayerID == layer.LayerID {
		return errors.New("observation layer linkage is invalid")
	}
	return nil
}

func validateCompactContext(raw json.RawMessage) error {
	if len(raw) == 0 {
		return errors.New("compact context is required")
	}
	var compact struct {
		States  []CompactState  `json:"states"`
		Actions []CompactAction `json:"actions"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&compact); err != nil {
		return errors.New("compact context is invalid")
	}
	if err := ensureJSONEOF(decoder); err != nil || len(compact.States) > 16 || len(compact.Actions) > 40 {
		return errors.New("compact context is invalid")
	}
	for _, state := range compact.States {
		if !ambientIdentifierPattern.MatchString(state.StateID) || strings.TrimSpace(state.Label) == "" ||
			len(state.Label) > 200 || strings.TrimSpace(state.RoutePattern) == "" ||
			len(state.RoutePattern) > 1000 || len(state.EvidenceHandles) == 0 ||
			len(state.EvidenceHandles) > 32 || !uniqueStrings(state.EvidenceHandles) {
			return errors.New("compact state is invalid")
		}
		for _, handle := range state.EvidenceHandles {
			if !ambientIdentifierPattern.MatchString(handle) {
				return errors.New("compact state evidence handle is invalid")
			}
		}
	}
	for _, action := range compact.Actions {
		if !ambientIdentifierPattern.MatchString(action.ActionID) || strings.TrimSpace(action.Title) == "" ||
			len(action.Title) > 200 || strings.TrimSpace(action.Precondition) == "" ||
			len(action.Precondition) > 500 || strings.TrimSpace(action.Effect) == "" ||
			len(action.Effect) > 500 ||
			len(action.Inputs) > 16 || len(action.EvidenceHandles) == 0 ||
			len(action.EvidenceHandles) > 32 || !uniqueStrings(action.EvidenceHandles) ||
			len(action.Output.Fields) > 32 || !uniqueStrings(action.Output.Fields) ||
			!oneOfString(action.Output.Mode, "none", "page", "collection") ||
			!oneOfString(action.Provenance, "inferred", "observed", "verified") {
			return errors.New("compact action is invalid")
		}
		for _, input := range action.Inputs {
			if !fieldNamePattern.MatchString(input.Name) ||
				!oneOfString(input.Type, "string", "number", "boolean") {
				return errors.New("compact action input is invalid")
			}
		}
		for _, field := range action.Output.Fields {
			if !fieldNamePattern.MatchString(field) {
				return errors.New("compact action output is invalid")
			}
		}
		for _, handle := range action.EvidenceHandles {
			if !ambientIdentifierPattern.MatchString(handle) {
				return errors.New("compact action evidence handle is invalid")
			}
		}
	}
	return nil
}

func validateScope(scope SiteScope, layerURL string) error {
	if len(scope.RoutePatterns) == 0 || len(scope.RoutePatterns) > 16 {
		return errors.New("site scope requires route patterns")
	}
	origin, err := url.Parse(scope.Origin)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.Path != "" ||
		origin.RawQuery != "" || origin.Fragment != "" || origin.User != nil {
		return errors.New("site scope origin must be an HTTP or HTTPS origin")
	}
	if origin.Scheme != "http" && origin.Scheme != "https" {
		return errors.New("site scope origin must be HTTP or HTTPS")
	}
	layer, err := url.Parse(layerURL)
	if err != nil || layer.Scheme+"://"+layer.Host != scope.Origin || layer.User != nil {
		return errors.New("layer URL must match the site scope origin")
	}
	seen := make(map[string]struct{}, len(scope.RoutePatterns))
	for _, pattern := range scope.RoutePatterns {
		if strings.TrimSpace(pattern) == "" || len(pattern) > 1000 {
			return errors.New("site route pattern is invalid")
		}
		if _, exists := seen[pattern]; exists {
			return errors.New("site route patterns must be unique")
		}
		seen[pattern] = struct{}{}
	}
	return nil
}

func validatePatchShape(patch ActionMapPatch) error {
	if patch.Decision != "patch" && patch.Decision != "no_change" {
		return errors.New("invalid patch decision")
	}
	if strings.TrimSpace(patch.Summary) == "" || len(patch.Summary) > 1000 ||
		patch.Operations == nil || len(patch.Operations) > 64 || len(patch.EvidenceCitations) == 0 ||
		len(patch.EvidenceCitations) > 256 {
		return errors.New("patch shape is invalid")
	}
	if (patch.Decision == "no_change" && len(patch.Operations) != 0) ||
		(patch.Decision == "patch" && len(patch.Operations) == 0) {
		return errors.New("patch operations do not match decision")
	}
	if err := validatePointer(patch.MapBase.Revision, patch.MapBase.Digest); err != nil {
		return err
	}
	if !ambientIdentifierPattern.MatchString(patch.Parser.ParserID) ||
		strings.TrimSpace(patch.Parser.ParserVersion) == "" ||
		len(patch.Parser.ParserVersion) > 100 ||
		strings.TrimSpace(patch.Parser.PromptVersion) == "" || len(patch.Parser.PromptVersion) > 100 {
		return errors.New("patch parser identity is invalid")
	}
	entityIDs := make(map[string]struct{}, len(patch.Operations))
	for _, operation := range patch.Operations {
		if !actionMapIdentifierPattern.MatchString(operation.EntityID) ||
			(operation.Provenance != "inferred" && operation.Provenance != "observed" &&
				operation.Provenance != "verified") ||
			strings.TrimSpace(operation.Reason) == "" || len(operation.Reason) > 1000 ||
			len(operation.CitationIDs) == 0 || len(operation.CitationIDs) > 32 ||
			!uniqueStrings(operation.CitationIDs) || !uniqueStrings(operation.ComponentActionIDs) {
			return errors.New("patch operation is invalid")
		}
		if _, exists := entityIDs[operation.EntityID]; exists {
			return errors.New("duplicate patch entity")
		}
		entityIDs[operation.EntityID] = struct{}{}
		switch operation.Operation {
		case "upsert_state":
			if operation.State == nil || operation.Action != nil || operation.State.ID != operation.EntityID ||
				len(operation.StepEvidence) != 0 || len(operation.ComponentActionIDs) != 0 ||
				strings.TrimSpace(operation.State.Label) == "" ||
				strings.TrimSpace(operation.State.URLPattern) == "" ||
				len(operation.State.Evidence) == 0 || len(operation.State.Evidence) > 8 ||
				!uniqueStrings(operation.State.Evidence) {
				return errors.New("state operation is invalid")
			}
		case "upsert_action":
			if operation.Action == nil || operation.State != nil || operation.Action.ID != operation.EntityID ||
				len(operation.StepEvidence) == 0 || len(operation.StepEvidence) > 64 ||
				operation.ComponentActionIDs == nil || len(operation.ComponentActionIDs) > 16 {
				return errors.New("action operation is invalid")
			}
			if operation.Action.Status == "unresolved" || len(operation.Action.Steps) == 0 ||
				len(operation.Action.Steps) > 20 || len(operation.Action.MissingEvidence) != 0 ||
				len(operation.Action.Evidence) == 0 || len(operation.Action.Evidence) > 10 ||
				!uniqueStrings(operation.Action.Evidence) || len(operation.Action.Parameters) > 8 ||
				len(operation.Action.Output.Fields) > 16 || operation.Action.Parameters == nil ||
				operation.Action.Steps == nil || operation.Action.Evidence == nil ||
				operation.Action.MissingEvidence == nil || operation.Action.Output.Fields == nil {
				return errors.New("ambient actions must be executable and evidence-complete")
			}
			for _, step := range operation.Action.Steps {
				if step.LiteralValue != nil {
					return errors.New("ambient action maps cannot persist literal typed values")
				}
			}
		default:
			return errors.New("unsupported patch operation")
		}
	}
	return nil
}

func validateEvidence(input ApplyActionMapRequest, metadata safeRevisionMetadata) error {
	citations := make(map[string]EvidenceCitation, len(input.Patch.EvidenceCitations))
	for _, citation := range input.Patch.EvidenceCitations {
		if !ambientIdentifierPattern.MatchString(citation.CitationID) ||
			!ambientIdentifierPattern.MatchString(citation.EvidenceID) ||
			!ambientIdentifierPattern.MatchString(citation.LayerID) ||
			!digestPattern.MatchString(citation.Digest) ||
			!oneOfString(citation.Source, "current_layer", "observation", "prior_context", "verification") ||
			!oneOfString(citation.Kind, "node", "event", "update", "state", "action") {
			return errors.New("evidence citation is invalid")
		}
		if _, exists := citations[citation.CitationID]; exists {
			return errors.New("duplicate evidence citation")
		}
		if !citationResolves(citation, input.Request, metadata) {
			return errors.New("evidence citation does not resolve")
		}
		citations[citation.CitationID] = citation
	}
	previousEntities := make(map[string]safeEntityMetadata, len(metadata.Entities))
	for _, entity := range metadata.Entities {
		previousEntities[entity.EntityKind+":"+entity.EntityID] = entity
	}
	for _, operation := range input.Patch.Operations {
		for _, citationID := range operation.CitationIDs {
			if _, exists := citations[citationID]; !exists {
				return errors.New("operation cites unknown evidence")
			}
		}
		kind := strings.TrimPrefix(operation.Operation, "upsert_")
		if previous, exists := previousEntities[kind+":"+operation.EntityID]; exists {
			if provenanceRank(operation.Provenance) < provenanceRank(previous.Provenance) {
				return errors.New("provenance cannot move backward")
			}
		}
		if operation.Operation != "upsert_action" {
			continue
		}
		if operation.Provenance == "verified" {
			previous, exists := previousEntities["action:"+operation.EntityID]
			if !exists || previous.Provenance != "verified" {
				return errors.New("ordinary ambient patches cannot create verified provenance")
			}
		}
		if err := validateActionStepEvidence(operation, input.Patch.EvidenceCitations); err != nil {
			return err
		}
	}
	return nil
}

func citationResolves(
	citation EvidenceCitation,
	request AmbientParseRequest,
	metadata safeRevisionMetadata,
) bool {
	switch citation.Source {
	case "current_layer":
		return citation.LayerID == request.Layer.LayerID &&
			citation.Digest == request.Layer.SemanticXMLDigest &&
			contains(request.Layer.EvidenceIDs, citation.EvidenceID)
	case "observation":
		if request.Observation == nil || citation.LayerID != request.Layer.LayerID {
			return false
		}
		observation := request.Observation
		return citation.EvidenceID == observation.ObservationID ||
			(observation.TargetEvidenceID != nil && citation.EvidenceID == *observation.TargetEvidenceID) ||
			contains(observation.Outcome.EvidenceIDs, citation.EvidenceID)
	case "prior_context", "verification":
		for _, previous := range metadata.Evidence {
			if previous.EvidenceID == citation.EvidenceID && previous.LayerID == citation.LayerID &&
				previous.Digest == citation.Digest {
				return citation.Source != "verification" || previous.Source == "verification"
			}
		}
	}
	return false
}

func validateActionStepEvidence(operation PatchOperation, citations []EvidenceCitation) error {
	action := operation.Action
	seen := make(map[string]struct{}, len(operation.StepEvidence))
	for _, binding := range operation.StepEvidence {
		if binding.StepIndex < 0 || binding.StepIndex >= len(action.Steps) ||
			(binding.Role != "target" && binding.Role != "effect" && binding.Role != "output") ||
			!ambientIdentifierPattern.MatchString(binding.EvidenceID) ||
			!ambientIdentifierPattern.MatchString(binding.LayerID) ||
			(binding.FieldName != nil && !fieldNamePattern.MatchString(*binding.FieldName)) {
			return errors.New("step evidence binding is invalid")
		}
		if (binding.Role == "target" || binding.Role == "effect") && binding.FieldName != nil {
			return errors.New("non-output evidence cannot name an output field")
		}
		if binding.Role == "output" && binding.FieldName != nil &&
			!actionHasOutputField(*action, *binding.FieldName) {
			return errors.New("output evidence names an unknown field")
		}
		key := fmt.Sprintf("%d:%s:%s:%s", binding.StepIndex, binding.Role, binding.EvidenceID, optionalString(binding.FieldName))
		if _, exists := seen[key]; exists {
			return errors.New("duplicate step evidence binding")
		}
		seen[key] = struct{}{}
		resolved := false
		for _, citation := range citations {
			if citation.EvidenceID == binding.EvidenceID && citation.LayerID == binding.LayerID {
				resolved = true
				break
			}
		}
		if !resolved || !actionEvidenceContains(*action, binding.EvidenceID) {
			return errors.New("step evidence is not retained on the action")
		}
	}
	for index, step := range action.Steps {
		if step.Operation == "click" && !hasStepBinding(operation.StepEvidence, index, "target", "") {
			return errors.New("click step has no target evidence")
		}
		if step.Operation == "extract" {
			for _, field := range action.Output.Fields {
				if !hasStepBinding(operation.StepEvidence, index, "output", field.Name) {
					return errors.New("extraction output field has no evidence")
				}
			}
		} else if operation.Provenance == "observed" && step.Expect.Kind != "none" &&
			!hasStepBinding(operation.StepEvidence, index, "effect", "") {
			return errors.New("observed step effect has no evidence")
		}
	}
	for _, componentID := range operation.ComponentActionIDs {
		if componentID == operation.EntityID || !actionMapIdentifierPattern.MatchString(componentID) {
			return errors.New("component action lineage is invalid")
		}
	}
	return nil
}

func validateVerifiedSemantics(input ApplyActionMapRequest, current ActionMapSnapshot) error {
	currentActions := make(map[string]actionmap.Action, len(current.ActionMap.Actions))
	for _, action := range current.ActionMap.Actions {
		currentActions[action.ID] = action
	}
	for _, operation := range input.Patch.Operations {
		if operation.Operation != "upsert_action" || operation.Provenance != "verified" {
			continue
		}
		previous, exists := currentActions[operation.EntityID]
		if !exists {
			return errors.New("verified action has no prior verified version")
		}
		previousJSON, err := canonicalJSON(previous)
		if err != nil {
			return err
		}
		nextJSON, err := canonicalJSON(*operation.Action)
		if err != nil {
			return err
		}
		if !bytes.Equal(previousJSON, nextJSON) {
			return errors.New("changed action semantics cannot retain verified provenance")
		}
	}
	return nil
}

func applyPatch(
	input ApplyActionMapRequest,
	base actionmap.Map,
	metadata safeRevisionMetadata,
) (actionmap.Map, safeRevisionMetadata, error) {
	result := cloneActionMap(base)
	normalizedURL, err := safeLayerURL(input.Request.Layer.URL)
	if err != nil {
		return actionmap.Map{}, safeRevisionMetadata{}, err
	}
	if !contains(result.Site.ObservedURLs, normalizedURL) {
		result.Site.ObservedURLs = append(result.Site.ObservedURLs, normalizedURL)
		if len(result.Site.ObservedURLs) > 12 {
			result.Site.ObservedURLs = result.Site.ObservedURLs[len(result.Site.ObservedURLs)-12:]
		}
	}
	result.Privacy.RedactionsApplied += input.Request.Privacy.RedactionCount
	result.Privacy.Categories = sortedUnique(append(
		append([]string(nil), result.Privacy.Categories...), input.Request.Privacy.Categories...,
	))
	operations := append([]PatchOperation(nil), input.Patch.Operations...)
	sort.Slice(operations, func(i, j int) bool {
		leftKind := operationOrder(operations[i].Operation)
		rightKind := operationOrder(operations[j].Operation)
		if leftKind != rightKind {
			return leftKind < rightKind
		}
		return operations[i].EntityID < operations[j].EntityID
	})
	entityMetadata := make(map[string]safeEntityMetadata, len(metadata.Entities)+len(operations))
	for _, entity := range metadata.Entities {
		entityMetadata[entity.EntityKind+":"+entity.EntityID] = entity
	}
	for _, operation := range operations {
		switch operation.Operation {
		case "upsert_state":
			result.States = upsertState(result.States, *operation.State)
			entityMetadata["state:"+operation.EntityID] = safeEntityMetadata{
				EntityKind: "state", EntityID: operation.EntityID, Provenance: operation.Provenance,
				EvidenceHandles: citationHandles(operation.CitationIDs, input.Patch.EvidenceCitations),
			}
		case "upsert_action":
			result.Actions = upsertAction(result.Actions, *operation.Action)
			entityMetadata["action:"+operation.EntityID] = safeEntityMetadata{
				EntityKind: "action", EntityID: operation.EntityID, Provenance: operation.Provenance,
				EvidenceHandles: stepEvidenceHandles(operation.StepEvidence),
			}
		}
	}
	sort.Slice(result.States, func(i, j int) bool { return result.States[i].ID < result.States[j].ID })
	sort.Slice(result.Actions, func(i, j int) bool { return result.Actions[i].ID < result.Actions[j].ID })
	nextMetadata := safeRevisionMetadata{
		Entities: make([]safeEntityMetadata, 0, len(entityMetadata)),
		Evidence: mergeEvidence(metadata.Evidence, input.Patch.EvidenceCitations),
		Bindings: mergeBindings(metadata.Bindings, safeBindings(input)),
	}
	for _, entity := range entityMetadata {
		entity.EvidenceHandles = sortedUnique(entity.EvidenceHandles)
		nextMetadata.Entities = append(nextMetadata.Entities, entity)
	}
	sort.Slice(nextMetadata.Entities, func(i, j int) bool {
		if nextMetadata.Entities[i].EntityKind != nextMetadata.Entities[j].EntityKind {
			return nextMetadata.Entities[i].EntityKind < nextMetadata.Entities[j].EntityKind
		}
		return nextMetadata.Entities[i].EntityID < nextMetadata.Entities[j].EntityID
	})
	if err := result.Validate(); err != nil {
		return actionmap.Map{}, safeRevisionMetadata{}, err
	}
	if err := validateActionMapSchemaBounds(result); err != nil {
		return actionmap.Map{}, safeRevisionMetadata{}, err
	}
	for _, operation := range operations {
		for _, componentID := range operation.ComponentActionIDs {
			if !actionMapHasAction(result, componentID) {
				return actionmap.Map{}, safeRevisionMetadata{}, errors.New("component action does not exist")
			}
		}
	}
	if err := scanStoredMap(result); err != nil {
		return actionmap.Map{}, safeRevisionMetadata{}, err
	}
	return result, nextMetadata, nil
}

func validateActionMapSchemaBounds(actionMap actionmap.Map) error {
	if len(actionMap.Site.ObservedURLs) > 12 || len(actionMap.Warnings) > 12 ||
		len(actionMap.Privacy.Categories) > 12 {
		return errors.New("action map exceeds canonical schema bounds")
	}
	for _, state := range actionMap.States {
		if len(state.Evidence) > 8 {
			return errors.New("action map state exceeds evidence bounds")
		}
	}
	for _, action := range actionMap.Actions {
		if len(action.Parameters) > 8 || len(action.Steps) > 20 || len(action.Evidence) > 10 ||
			len(action.MissingEvidence) > 10 || len(action.Output.Fields) > 16 {
			return errors.New("action map action exceeds schema bounds")
		}
	}
	return nil
}

func scanStoredMap(actionMap actionmap.Map) error {
	encoded, err := json.Marshal(actionMap)
	if err != nil {
		return err
	}
	text := string(encoded)
	if strings.Contains(strings.ToLower(text), "<semantic-ui") ||
		strings.Contains(strings.ToLower(text), "{{redacted.") ||
		emailPattern.MatchString(text) || longNumberPattern.MatchString(text) {
		return errors.New("action map contains private page or typed-value material")
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return err
	}
	if containsURLWithPrivateSuffix(decoded) {
		return errors.New("action map contains a URL with a query or fragment")
	}
	for _, observedURL := range actionMap.Site.ObservedURLs {
		parsed, err := url.Parse(observedURL)
		if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			return errors.New("stored observed URLs must omit query and fragment")
		}
	}
	return nil
}

func containsURLWithPrivateSuffix(value any) bool {
	switch typed := value.(type) {
	case string:
		if !strings.HasPrefix(typed, "http://") && !strings.HasPrefix(typed, "https://") {
			return false
		}
		parsed, err := url.Parse(typed)
		return err == nil && parsed.Host != "" && (parsed.RawQuery != "" || parsed.Fragment != "")
	case []any:
		for _, item := range typed {
			if containsURLWithPrivateSuffix(item) {
				return true
			}
		}
	case map[string]any:
		for _, item := range typed {
			if containsURLWithPrivateSuffix(item) {
				return true
			}
		}
	}
	return false
}

func ProjectActionMapContext(snapshot ActionMapSnapshot, metadata safeRevisionMetadata) ActionMapContext {
	provenance := make(map[string]safeEntityMetadata, len(metadata.Entities))
	for _, entity := range metadata.Entities {
		provenance[entity.EntityKind+":"+entity.EntityID] = entity
	}
	statesByID := make(map[string]actionmap.State, len(snapshot.ActionMap.States))
	context := ActionMapContext{
		SiteScopeID: snapshot.SiteScopeID,
		Revision:    snapshot.Revision,
		Digest:      copyDigest(snapshot.Digest),
		States:      make([]CompactState, 0, len(snapshot.ActionMap.States)),
		Actions:     make([]CompactAction, 0, len(snapshot.ActionMap.Actions)),
	}
	for _, state := range snapshot.ActionMap.States {
		statesByID[state.ID] = state
		entity := provenance["state:"+state.ID]
		context.States = append(context.States, CompactState{
			StateID: state.ID, Label: state.Label, RoutePattern: state.URLPattern,
			EvidenceHandles: append([]string(nil), entity.EvidenceHandles...),
		})
	}
	for _, action := range snapshot.ActionMap.Actions {
		entity := provenance["action:"+action.ID]
		inputs := make([]CompactInput, 0, len(action.Parameters))
		for _, parameter := range action.Parameters {
			inputs = append(inputs, CompactInput{
				Name: parameter.Name, Type: parameter.Type, Required: parameter.Required,
			})
		}
		fields := make([]string, 0, len(action.Output.Fields))
		for _, field := range action.Output.Fields {
			fields = append(fields, field.Name)
		}
		sort.Strings(fields)
		context.Actions = append(context.Actions, CompactAction{
			ActionID:        action.ID,
			Title:           action.Name,
			Precondition:    compactPrecondition(action, statesByID),
			Effect:          compactEffect(action, statesByID),
			Inputs:          inputs,
			Output:          CompactOutput{Mode: action.Output.Mode, Fields: fields},
			EvidenceHandles: append([]string(nil), entity.EvidenceHandles...),
			Provenance:      entity.Provenance,
		})
	}
	return context
}

func compactPrecondition(action actionmap.Action, states map[string]actionmap.State) string {
	if state, exists := states[action.FromState]; exists {
		return state.Label + " is visible."
	}
	return "The action entry state is visible."
}

func compactEffect(action actionmap.Action, states map[string]actionmap.State) string {
	if action.ToState != nil {
		if state, exists := states[*action.ToState]; exists {
			if action.Output.Mode == "collection" {
				return "Return the declared collection from " + state.Label + "."
			}
			return "Reach " + state.Label + "."
		}
	}
	if action.Output.Mode == "collection" {
		return "Return the declared collection."
	}
	return "Complete the declared action."
}

func ambientIdempotencyDigest(request AmbientParseRequest) (string, error) {
	values := []any{
		request.SiteScope.ScopeID,
		request.Layer.Sequence,
		request.Layer.URL,
		request.Layer.SemanticXMLDigest,
		request.Observation,
		request.MapBase.Revision,
		request.MapBase.Digest,
		request.Parser.ParserID,
		request.Parser.ParserVersion,
		request.Parser.PromptVersion,
	}
	return canonicalDigest(values)
}

func applicationInputDigest(input ApplyActionMapRequest) (string, error) {
	type canonicalRequest struct {
		SchemaVersion  string              `json:"schemaVersion"`
		RequestID      string              `json:"requestId"`
		IdempotencyKey string              `json:"idempotencyKey"`
		RetryOf        *string             `json:"retryOf"`
		SiteScope      SiteScope           `json:"siteScope"`
		Layer          SemanticLayer       `json:"layer"`
		Observation    *AmbientObservation `json:"observation"`
		MapBase        MapBase             `json:"mapBase"`
		Context        json.RawMessage     `json:"context"`
		Parser         ParserIdentity      `json:"parser"`
		Policy         PolicyDecision      `json:"policy"`
		Privacy        AmbientPrivacy      `json:"privacy"`
	}
	request := input.Request
	canonical := canonicalRequest{
		SchemaVersion: request.SchemaVersion, RequestID: request.RequestID,
		IdempotencyKey: request.IdempotencyKey, RetryOf: request.RetryOf,
		SiteScope: request.SiteScope, Layer: request.Layer,
		Observation: request.Observation, MapBase: request.MapBase, Context: request.Context,
		Parser: request.Parser, Policy: request.Policy, Privacy: request.Privacy,
	}
	return canonicalDigest([]any{canonical, input.Patch})
}

func canonicalMap(actionMap actionmap.Map) (string, []byte, error) {
	canonical, err := canonicalJSON(actionMap)
	if err != nil {
		return "", nil, err
	}
	return digestBytes(canonical), canonical, nil
}

func canonicalDigest(value any) (string, error) {
	canonical, err := canonicalJSON(value)
	if err != nil {
		return "", err
	}
	return digestBytes(canonical), nil
}

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := writeCanonicalJSON(&output, decoded); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func writeCanonicalJSON(output *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		output.WriteString("null")
	case bool:
		output.WriteString(strconv.FormatBool(typed))
	case string:
		writeCanonicalString(output, typed)
	case json.Number:
		number, err := strconv.ParseFloat(typed.String(), 64)
		if err != nil {
			return err
		}
		if number == 0 {
			output.WriteByte('0')
		} else {
			output.WriteString(typed.String())
		}
	case []any:
		output.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeCanonicalJSON(output, item); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			writeCanonicalString(output, key)
			output.WriteByte(':')
			if err := writeCanonicalJSON(output, typed[key]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return fmt.Errorf("unsupported canonical JSON value %T", typed)
	}
	return nil
}

func writeCanonicalString(output *bytes.Buffer, value string) {
	const hexadecimal = "0123456789abcdef"
	output.WriteByte('"')
	for _, character := range []byte(value) {
		switch character {
		case '"', '\\':
			output.WriteByte('\\')
			output.WriteByte(character)
		case '\b':
			output.WriteString(`\b`)
		case '\t':
			output.WriteString(`\t`)
		case '\n':
			output.WriteString(`\n`)
		case '\f':
			output.WriteString(`\f`)
		case '\r':
			output.WriteString(`\r`)
		default:
			if character < 0x20 {
				output.WriteString(`\u00`)
				output.WriteByte(hexadecimal[character>>4])
				output.WriteByte(hexadecimal[character&0x0f])
			} else {
				output.WriteByte(character)
			}
		}
	}
	output.WriteByte('"')
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values are not canonical")
	}
	return err
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func safeLayerURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("layer URL is invalid")
	}
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	parsed.RawFragment = ""
	parsed.User = nil
	return parsed.String(), nil
}

func cloneActionMap(value actionmap.Map) actionmap.Map {
	encoded, _ := json.Marshal(value)
	var result actionmap.Map
	_ = json.Unmarshal(encoded, &result)
	return result
}

func upsertState(states []actionmap.State, state actionmap.State) []actionmap.State {
	for index := range states {
		if states[index].ID == state.ID {
			states[index] = state
			return states
		}
	}
	return append(states, state)
}

func upsertAction(actions []actionmap.Action, action actionmap.Action) []actionmap.Action {
	for index := range actions {
		if actions[index].ID == action.ID {
			actions[index] = action
			return actions
		}
	}
	return append(actions, action)
}

func operationOrder(operation string) int {
	if operation == "upsert_state" {
		return 0
	}
	return 1
}

func citationHandles(ids []string, citations []EvidenceCitation) []string {
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		for _, citation := range citations {
			if citation.CitationID == id {
				result = append(result, citation.EvidenceID)
				break
			}
		}
	}
	return sortedUnique(result)
}

func stepEvidenceHandles(bindings []StepEvidence) []string {
	result := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		result = append(result, binding.EvidenceID)
	}
	return sortedUnique(result)
}

func mergeEvidence(existing, incoming []EvidenceCitation) []EvidenceCitation {
	byKey := make(map[string]EvidenceCitation, len(existing)+len(incoming))
	for _, citation := range append(append([]EvidenceCitation(nil), existing...), incoming...) {
		key := citation.LayerID + ":" + citation.EvidenceID + ":" + citation.Digest
		byKey[key] = citation
	}
	result := make([]EvidenceCitation, 0, len(byKey))
	for _, citation := range byKey {
		result = append(result, citation)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].LayerID != result[j].LayerID {
			return result[i].LayerID < result[j].LayerID
		}
		return result[i].EvidenceID < result[j].EvidenceID
	})
	return result
}

func safeBindings(input ApplyActionMapRequest) []safeEvidenceBinding {
	citations := make(map[string]EvidenceCitation, len(input.Patch.EvidenceCitations))
	for _, citation := range input.Patch.EvidenceCitations {
		citations[citation.EvidenceID+":"+citation.LayerID] = citation
	}
	result := make([]safeEvidenceBinding, 0)
	for _, operation := range input.Patch.Operations {
		entityKind := strings.TrimPrefix(operation.Operation, "upsert_")
		if operation.Operation == "upsert_state" {
			for _, citationID := range operation.CitationIDs {
				for _, citation := range input.Patch.EvidenceCitations {
					if citation.CitationID != citationID {
						continue
					}
					result = append(result, safeEvidenceBinding{
						EntityKind: entityKind, EntityID: operation.EntityID,
						Provenance: operation.Provenance, LayerSequence: input.Request.Layer.Sequence,
						LayerID: citation.LayerID, EvidenceID: citation.EvidenceID,
						ContentDigest: citation.Digest, BindingRole: "state",
					})
				}
			}
			continue
		}
		for _, binding := range operation.StepEvidence {
			citation := citations[binding.EvidenceID+":"+binding.LayerID]
			stepIndex := binding.StepIndex
			result = append(result, safeEvidenceBinding{
				EntityKind: entityKind, EntityID: operation.EntityID,
				Provenance: operation.Provenance, LayerSequence: input.Request.Layer.Sequence,
				LayerID: binding.LayerID, EvidenceID: binding.EvidenceID,
				ContentDigest: citation.Digest, BindingRole: binding.Role,
				StepIndex: &stepIndex, FieldName: copyDigest(binding.FieldName),
			})
		}
	}
	return result
}

func mergeBindings(existing, incoming []safeEvidenceBinding) []safeEvidenceBinding {
	byKey := make(map[string]safeEvidenceBinding, len(existing)+len(incoming))
	for _, binding := range append(append([]safeEvidenceBinding(nil), existing...), incoming...) {
		key := strings.Join([]string{
			binding.EntityKind,
			binding.EntityID,
			binding.LayerID,
			binding.EvidenceID,
			binding.BindingRole,
			strconv.Itoa(optionalInt(binding.StepIndex)),
			optionalString(binding.FieldName),
		}, ":")
		byKey[key] = binding
	}
	result := make([]safeEvidenceBinding, 0, len(byKey))
	for _, binding := range byKey {
		result = append(result, binding)
	}
	sort.Slice(result, func(i, j int) bool {
		left := result[i]
		right := result[j]
		if left.EntityKind != right.EntityKind {
			return left.EntityKind < right.EntityKind
		}
		if left.EntityID != right.EntityID {
			return left.EntityID < right.EntityID
		}
		if left.LayerSequence != right.LayerSequence {
			return left.LayerSequence < right.LayerSequence
		}
		if left.StepIndex != nil && right.StepIndex != nil && *left.StepIndex != *right.StepIndex {
			return *left.StepIndex < *right.StepIndex
		}
		if left.BindingRole != right.BindingRole {
			return left.BindingRole < right.BindingRole
		}
		return left.EvidenceID < right.EvidenceID
	})
	return result
}

func sortedUnique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func actionEvidenceContains(action actionmap.Action, evidenceID string) bool {
	for _, token := range action.Evidence {
		if strings.Contains(token, ":"+evidenceID+":") || strings.HasSuffix(token, ":"+evidenceID) {
			return true
		}
	}
	return false
}

func actionHasOutputField(action actionmap.Action, fieldName string) bool {
	for _, field := range action.Output.Fields {
		if field.Name == fieldName {
			return true
		}
	}
	return false
}

func actionMapHasAction(actionMap actionmap.Map, actionID string) bool {
	for _, action := range actionMap.Actions {
		if action.ID == actionID {
			return true
		}
	}
	return false
}

func hasStepBinding(bindings []StepEvidence, index int, role, fieldName string) bool {
	for _, binding := range bindings {
		if binding.StepIndex == index && binding.Role == role && optionalString(binding.FieldName) == fieldName {
			return true
		}
	}
	return false
}

func validatePointer(revision int, digest *string) error {
	if revision < 0 || (revision == 0 && digest != nil) || (revision > 0 && digest == nil) {
		return errors.New("invalid revision pointer")
	}
	if digest != nil && !digestPattern.MatchString(*digest) {
		return errors.New("invalid revision digest")
	}
	return nil
}

func pointerFromBase(base PatchMapBase) RevisionPointer {
	return RevisionPointer{Revision: base.Revision, Digest: copyDigest(base.Digest)}
}

func pointerFromSnapshot(snapshot ActionMapSnapshot) RevisionPointer {
	return RevisionPointer{Revision: snapshot.Revision, Digest: copyDigest(snapshot.Digest)}
}

func copyDigest(value *string) *string {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}

func equalDigest(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func optionalInt(value *int) int {
	if value == nil {
		return -1
	}
	return *value
}

func provenanceRank(value string) int {
	switch value {
	case "inferred":
		return 1
	case "observed":
		return 2
	case "verified":
		return 3
	default:
		return 0
	}
}

func validUTF8Strings(values []string) bool {
	for _, value := range values {
		if !utf8.ValidString(value) {
			return false
		}
	}
	return true
}

func uniqueStrings(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func oneOfString(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
