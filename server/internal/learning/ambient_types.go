package learning

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"webmcp-automator/server/internal/actionmap"
)

const (
	AmbientParseRequestVersion = "ambient-parse-request/1"
	ActionMapPatchVersion      = "action-map-patch/1"
	AmbientParserID            = "ambient_action_parser"
	AmbientParserVersion       = "1.0.0"
	AmbientPromptVersion       = "ambient-v1"
)

type Rejection struct {
	Code    string `json:"code"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

func (rejection Rejection) Error() string {
	return fmt.Sprintf("%s at %s: %s", rejection.Code, rejection.Path, rejection.Message)
}

type SiteScope struct {
	ScopeID       string   `json:"scopeId"`
	Origin        string   `json:"origin"`
	RoutePatterns []string `json:"routePatterns"`
}

type SemanticLayer struct {
	LayerID            string    `json:"layerId"`
	Sequence           int       `json:"sequence"`
	CompletedAt        time.Time `json:"completedAt"`
	CompletionReason   string    `json:"completionReason"`
	URL                string    `json:"url"`
	SemanticXMLVersion string    `json:"semanticXmlVersion"`
	SemanticXMLDigest  string    `json:"semanticXmlDigest"`
	SemanticXML        string    `json:"semanticXml"`
	EvidenceIDs        []string  `json:"evidenceIds"`
}

type ObservationOutcome struct {
	Kind        string   `json:"kind"`
	EvidenceIDs []string `json:"evidenceIds"`
}

type CausalObservation struct {
	ObservationID    string             `json:"observationId"`
	EventSequence    int                `json:"eventSequence"`
	FromLayerID      string             `json:"fromLayerId"`
	Kind             string             `json:"kind"`
	TargetEvidenceID *string            `json:"targetEvidenceId"`
	ArgumentTokens   []string           `json:"argumentTokens"`
	Outcome          ObservationOutcome `json:"outcome"`
}

type PolicyDecision struct {
	DecisionID string    `json:"decisionId"`
	Status     string    `json:"status"`
	Scope      string    `json:"scope"`
	CheckedAt  time.Time `json:"checkedAt"`
}

type PrivacySummary struct {
	SanitizerVersion string   `json:"sanitizerVersion"`
	RedactionCount   int      `json:"redactionCount"`
	RedactionDigest  string   `json:"redactionDigest"`
	Categories       []string `json:"categories"`
	RawPersisted     bool     `json:"rawPersisted"`
}

type CompletedLayer struct {
	SiteScope   SiteScope          `json:"siteScope"`
	Layer       SemanticLayer      `json:"layer"`
	Observation *CausalObservation `json:"observation"`
	Policy      PolicyDecision     `json:"policy"`
	Privacy     PrivacySummary     `json:"privacy"`
}

type RevisionPointer struct {
	Revision int     `json:"revision"`
	Digest   *string `json:"digest"`
}

type MapBase struct {
	Revision              int     `json:"revision"`
	Digest                *string `json:"digest"`
	PreviousLayerSequence int     `json:"previousLayerSequence"`
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
}

type CompactContext struct {
	States  []CompactState  `json:"states"`
	Actions []CompactAction `json:"actions"`
}

type ParserProfile struct {
	ParserID            string `json:"parserId"`
	ParserVersion       string `json:"parserVersion"`
	PromptVersion       string `json:"promptVersion"`
	OutputSchemaVersion string `json:"outputSchemaVersion"`
}

type PatchParserIdentity struct {
	ParserID      string `json:"parserId"`
	ParserVersion string `json:"parserVersion"`
	PromptVersion string `json:"promptVersion"`
}

type ParseRequest struct {
	SchemaVersion  string             `json:"schemaVersion"`
	RequestID      string             `json:"requestId"`
	IdempotencyKey string             `json:"idempotencyKey"`
	Attempt        int                `json:"attempt"`
	RetryOf        *string            `json:"retryOf"`
	SiteScope      SiteScope          `json:"siteScope"`
	Layer          SemanticLayer      `json:"layer"`
	Observation    *CausalObservation `json:"observation"`
	MapBase        MapBase            `json:"mapBase"`
	Context        CompactContext     `json:"context"`
	Parser         ParserProfile      `json:"parser"`
	Policy         PolicyDecision     `json:"policy"`
	Privacy        PrivacySummary     `json:"privacy"`
}

type RequestIdentity struct {
	RequestID string
	Attempt   int
	RetryOf   *string
}

type EvidenceCitation struct {
	CitationID string `json:"citationId"`
	EvidenceID string `json:"evidenceId"`
	LayerID    string `json:"layerId"`
	Source     string `json:"source"`
	Kind       string `json:"kind"`
	Digest     string `json:"digest"`
}

type StepEvidence struct {
	StepIndex  int     `json:"stepIndex"`
	Role       string  `json:"role"`
	EvidenceID string  `json:"evidenceId"`
	LayerID    string  `json:"layerId"`
	FieldName  *string `json:"fieldName"`
}

type PatchOperation struct {
	Op                 string            `json:"op"`
	EntityID           string            `json:"entityId"`
	State              *actionmap.State  `json:"state,omitempty"`
	Action             *actionmap.Action `json:"action,omitempty"`
	Provenance         string            `json:"provenance"`
	Reason             string            `json:"reason"`
	ComponentActionIDs []string          `json:"componentActionIds,omitempty"`
	CitationIDs        []string          `json:"citationIds"`
	StepEvidence       []StepEvidence    `json:"stepEvidence,omitempty"`
}

func (operation PatchOperation) MarshalJSON() ([]byte, error) {
	switch operation.Op {
	case "upsert_state":
		return json.Marshal(struct {
			Op          string           `json:"op"`
			EntityID    string           `json:"entityId"`
			State       *actionmap.State `json:"state"`
			Provenance  string           `json:"provenance"`
			Reason      string           `json:"reason"`
			CitationIDs []string         `json:"citationIds"`
		}{operation.Op, operation.EntityID, operation.State, operation.Provenance, operation.Reason, operation.CitationIDs})
	case "upsert_action":
		return json.Marshal(struct {
			Op                 string            `json:"op"`
			EntityID           string            `json:"entityId"`
			Action             *actionmap.Action `json:"action"`
			Provenance         string            `json:"provenance"`
			Reason             string            `json:"reason"`
			ComponentActionIDs []string          `json:"componentActionIds"`
			CitationIDs        []string          `json:"citationIds"`
			StepEvidence       []StepEvidence    `json:"stepEvidence"`
		}{operation.Op, operation.EntityID, operation.Action, operation.Provenance, operation.Reason, operation.ComponentActionIDs, operation.CitationIDs, operation.StepEvidence})
	default:
		return nil, fmt.Errorf("unsupported patch operation %q", operation.Op)
	}
}

type ActionMapPatch struct {
	SchemaVersion     string              `json:"schemaVersion"`
	PatchID           string              `json:"patchId"`
	RequestID         string              `json:"requestId"`
	IdempotencyKey    string              `json:"idempotencyKey"`
	SiteScopeID       string              `json:"siteScopeId"`
	LayerSequence     int                 `json:"layerSequence"`
	MapBase           RevisionPointer     `json:"mapBase"`
	Parser            PatchParserIdentity `json:"parser"`
	Decision          string              `json:"decision"`
	Summary           string              `json:"summary"`
	Operations        []PatchOperation    `json:"operations"`
	EvidenceCitations []EvidenceCitation  `json:"evidenceCitations"`
}

type MaterializedPatch struct {
	Patch       ActionMapPatch
	ActionMap   actionmap.Map
	Diagnostics []Diagnostic
	Sidecars    map[string][]StepEvidence
}

type Parser interface {
	Parse(context.Context, ParseRequest) (json.RawMessage, error)
}
