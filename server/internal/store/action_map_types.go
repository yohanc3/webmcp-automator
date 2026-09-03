package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"webmcp-automator/server/internal/actionmap"
)

const (
	ActionMapPatchSchemaVersion    = "action-map-patch/1"
	ActionMapRevisionSchemaVersion = "action-map-revision/1"
	AmbientParseSchemaVersion      = "ambient-parse-request/1"
	AmbientValidatorVersion        = "ambient-contract-validator/1"
)

type RevisionPointer struct {
	Revision int     `json:"revision"`
	Digest   *string `json:"digest"`
}

type MapBase struct {
	Revision              int     `json:"revision"`
	Digest                *string `json:"digest"`
	PreviousLayerSequence int     `json:"previousLayerSequence,omitempty"`
}

type ParserIdentity struct {
	ParserID            string `json:"parserId"`
	ParserVersion       string `json:"parserVersion"`
	PromptVersion       string `json:"promptVersion"`
	OutputSchemaVersion string `json:"outputSchemaVersion,omitempty"`
}

type SiteScope struct {
	ScopeID       string   `json:"scopeId"`
	Origin        string   `json:"origin"`
	RoutePatterns []string `json:"routePatterns"`
}

type SemanticLayer struct {
	LayerID            string   `json:"layerId"`
	Sequence           int      `json:"sequence"`
	CompletedAt        string   `json:"completedAt"`
	CompletionReason   string   `json:"completionReason"`
	URL                string   `json:"url"`
	SemanticXMLVersion string   `json:"semanticXmlVersion"`
	SemanticXMLDigest  string   `json:"semanticXmlDigest"`
	SemanticXML        string   `json:"semanticXml"`
	EvidenceIDs        []string `json:"evidenceIds"`
}

type ObservationOutcome struct {
	Kind        string   `json:"kind"`
	EvidenceIDs []string `json:"evidenceIds"`
}

type AmbientObservation struct {
	ObservationID    string             `json:"observationId"`
	EventSequence    int                `json:"eventSequence"`
	FromLayerID      string             `json:"fromLayerId"`
	Kind             string             `json:"kind"`
	TargetEvidenceID *string            `json:"targetEvidenceId"`
	ArgumentTokens   []string           `json:"argumentTokens"`
	Outcome          ObservationOutcome `json:"outcome"`
}

type PolicyDecision struct {
	DecisionID string `json:"decisionId"`
	Status     string `json:"status"`
	Scope      string `json:"scope"`
	CheckedAt  string `json:"checkedAt"`
}

type AmbientPrivacy struct {
	SanitizerVersion string   `json:"sanitizerVersion"`
	RedactionCount   int      `json:"redactionCount"`
	RedactionDigest  string   `json:"redactionDigest"`
	Categories       []string `json:"categories"`
	RawPersisted     bool     `json:"rawPersisted"`
}

type AmbientParseRequest struct {
	SchemaVersion  string              `json:"schemaVersion"`
	RequestID      string              `json:"requestId"`
	IdempotencyKey string              `json:"idempotencyKey"`
	Attempt        int                 `json:"attempt"`
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

type PatchMapBase struct {
	Revision int     `json:"revision"`
	Digest   *string `json:"digest"`
}

type StepEvidence struct {
	StepIndex  int     `json:"stepIndex"`
	Role       string  `json:"role"`
	EvidenceID string  `json:"evidenceId"`
	LayerID    string  `json:"layerId"`
	FieldName  *string `json:"fieldName"`
}

type EvidenceCitation struct {
	CitationID string `json:"citationId"`
	EvidenceID string `json:"evidenceId"`
	LayerID    string `json:"layerId"`
	Source     string `json:"source"`
	Kind       string `json:"kind"`
	Digest     string `json:"digest"`
}

type PatchOperation struct {
	Operation          string            `json:"op"`
	EntityID           string            `json:"entityId"`
	State              *actionmap.State  `json:"state,omitempty"`
	Action             *actionmap.Action `json:"action,omitempty"`
	Provenance         string            `json:"provenance"`
	Reason             string            `json:"reason"`
	ComponentActionIDs []string          `json:"componentActionIds,omitempty"`
	CitationIDs        []string          `json:"citationIds"`
	StepEvidence       []StepEvidence    `json:"stepEvidence,omitempty"`
}

func (operation *PatchOperation) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	var operationName string
	if rawOperation, exists := fields["op"]; exists {
		if err := json.Unmarshal(rawOperation, &operationName); err != nil {
			return errors.New("patch operation op must be a string")
		}
	}
	var required []string
	switch operationName {
	case "upsert_state":
		required = []string{"op", "entityId", "state", "provenance", "reason", "citationIds"}
	case "upsert_action":
		required = []string{
			"op", "entityId", "action", "provenance", "reason", "componentActionIds",
			"citationIds", "stepEvidence",
		}
	default:
		return fmt.Errorf("unsupported patch operation %q", operationName)
	}
	if len(fields) != len(required) {
		return errors.New("patch operation has missing or unknown fields")
	}
	for _, field := range required {
		if _, exists := fields[field]; !exists {
			return fmt.Errorf("patch operation is missing %s", field)
		}
	}
	type patchOperationAlias PatchOperation
	var decoded patchOperationAlias
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*operation = PatchOperation(decoded)
	return nil
}

func (operation PatchOperation) MarshalJSON() ([]byte, error) {
	switch operation.Operation {
	case "upsert_state":
		return json.Marshal(struct {
			Operation   string           `json:"op"`
			EntityID    string           `json:"entityId"`
			State       *actionmap.State `json:"state"`
			Provenance  string           `json:"provenance"`
			Reason      string           `json:"reason"`
			CitationIDs []string         `json:"citationIds"`
		}{
			Operation: operation.Operation, EntityID: operation.EntityID, State: operation.State,
			Provenance: operation.Provenance, Reason: operation.Reason, CitationIDs: operation.CitationIDs,
		})
	case "upsert_action":
		return json.Marshal(struct {
			Operation          string            `json:"op"`
			EntityID           string            `json:"entityId"`
			Action             *actionmap.Action `json:"action"`
			Provenance         string            `json:"provenance"`
			Reason             string            `json:"reason"`
			ComponentActionIDs []string          `json:"componentActionIds"`
			CitationIDs        []string          `json:"citationIds"`
			StepEvidence       []StepEvidence    `json:"stepEvidence"`
		}{
			Operation: operation.Operation, EntityID: operation.EntityID, Action: operation.Action,
			Provenance: operation.Provenance, Reason: operation.Reason,
			ComponentActionIDs: operation.ComponentActionIDs, CitationIDs: operation.CitationIDs,
			StepEvidence: operation.StepEvidence,
		})
	default:
		return nil, fmt.Errorf("unsupported patch operation %q", operation.Operation)
	}
}

type ActionMapPatch struct {
	SchemaVersion     string             `json:"schemaVersion"`
	PatchID           string             `json:"patchId"`
	RequestID         string             `json:"requestId"`
	IdempotencyKey    string             `json:"idempotencyKey"`
	SiteScopeID       string             `json:"siteScopeId"`
	LayerSequence     int                `json:"layerSequence"`
	MapBase           PatchMapBase       `json:"mapBase"`
	Parser            ParserIdentity     `json:"parser"`
	Decision          string             `json:"decision"`
	Summary           string             `json:"summary"`
	Operations        []PatchOperation   `json:"operations"`
	EvidenceCitations []EvidenceCitation `json:"evidenceCitations"`
}

type ApplyActionMapRequest struct {
	Request AmbientParseRequest `json:"request"`
	Patch   ActionMapPatch      `json:"patch"`
}

type RevisionApplication struct {
	Status       string           `json:"status"`
	Base         RevisionPointer  `json:"base"`
	Result       *RevisionPointer `json:"result"`
	Current      RevisionPointer  `json:"current"`
	ConflictCode *string          `json:"conflictCode"`
}

type RevisionValidation struct {
	ValidatorVersion        string   `json:"validatorVersion"`
	ActionMapSchemaVersion  string   `json:"actionMapSchemaVersion"`
	ActionListSchemaVersion string   `json:"actionListSchemaVersion"`
	Checks                  []string `json:"checks"`
}

type RevisionStorage struct {
	ActionMapRevisionStored    bool `json:"actionMapRevisionStored"`
	SafeEvidenceMetadataCount  int  `json:"safeEvidenceMetadataCount"`
	SemanticXMLStored          bool `json:"semanticXmlStored"`
	SanitizedObservationStored bool `json:"sanitizedObservationStored"`
	RawObservationStored       bool `json:"rawObservationStored"`
}

type ActionMapReceipt struct {
	SchemaVersion       string              `json:"schemaVersion"`
	RequestID           string              `json:"requestId"`
	PatchID             string              `json:"patchId"`
	IdempotencyKey      string              `json:"idempotencyKey"`
	SiteScopeID         string              `json:"siteScopeId"`
	SourceLayerSequence int                 `json:"sourceLayerSequence"`
	Application         RevisionApplication `json:"application"`
	Parser              ParserIdentity      `json:"parser"`
	Validation          RevisionValidation  `json:"validation"`
	Storage             RevisionStorage     `json:"storage"`
	AppliedAt           time.Time           `json:"appliedAt"`
}

type ActionMapSnapshot struct {
	SiteScopeID         string        `json:"siteScopeId"`
	Revision            int           `json:"revision"`
	Digest              *string       `json:"digest"`
	SourceLayerSequence int           `json:"sourceLayerSequence"`
	ActionMap           actionmap.Map `json:"actionMap"`
	CreatedAt           *time.Time    `json:"createdAt"`
}

type CompactState struct {
	StateID         string   `json:"stateId"`
	Label           string   `json:"label"`
	RoutePattern    string   `json:"routePattern"`
	EvidenceHandles []string `json:"evidenceHandles"`
}

type CompactInput struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

type CompactOutput struct {
	Mode   string   `json:"mode"`
	Fields []string `json:"fields"`
}

type CompactAction struct {
	ActionID        string         `json:"actionId"`
	Title           string         `json:"title"`
	Precondition    string         `json:"precondition"`
	Effect          string         `json:"effect"`
	Inputs          []CompactInput `json:"inputs"`
	Output          CompactOutput  `json:"output"`
	EvidenceHandles []string       `json:"evidenceHandles"`
	Provenance      string         `json:"provenance"`
	Confidence      float64        `json:"confidence,omitempty"`
}

type ActionMapContext struct {
	SiteScopeID         string          `json:"siteScopeId"`
	Revision            int             `json:"revision"`
	Digest              *string         `json:"digest"`
	SourceLayerSequence int             `json:"sourceLayerSequence"`
	States              []CompactState  `json:"states"`
	Actions             []CompactAction `json:"actions"`
}

type safeEntityMetadata struct {
	EntityKind      string   `json:"entityKind"`
	EntityID        string   `json:"entityId"`
	Provenance      string   `json:"provenance"`
	EvidenceHandles []string `json:"evidenceHandles"`
}

type safeRevisionMetadata struct {
	Entities []safeEntityMetadata  `json:"entities"`
	Evidence []EvidenceCitation    `json:"evidence"`
	Bindings []safeEvidenceBinding `json:"bindings"`
}

type safeEvidenceBinding struct {
	EntityKind    string  `json:"entityKind"`
	EntityID      string  `json:"entityId"`
	Provenance    string  `json:"provenance"`
	LayerSequence int     `json:"layerSequence"`
	LayerID       string  `json:"layerId"`
	EvidenceID    string  `json:"evidenceId"`
	ContentDigest string  `json:"contentDigest"`
	BindingRole   string  `json:"bindingRole"`
	StepIndex     *int    `json:"stepIndex"`
	FieldName     *string `json:"fieldName"`
}
