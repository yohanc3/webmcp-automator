package contracts_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"webmcp-automator/server/internal/actionmap"
)

type parseFixture struct {
	SchemaVersion  string `json:"schemaVersion"`
	RequestID      string `json:"requestId"`
	IdempotencyKey string `json:"idempotencyKey"`
	SiteScope      struct {
		ScopeID string `json:"scopeId"`
		Origin  string `json:"origin"`
	} `json:"siteScope"`
	Layer struct {
		LayerID     string   `json:"layerId"`
		Sequence    int      `json:"sequence"`
		SemanticXML string   `json:"semanticXml"`
		EvidenceIDs []string `json:"evidenceIds"`
	} `json:"layer"`
	Observation *struct {
		ObservationID    string  `json:"observationId"`
		TargetEvidenceID *string `json:"targetEvidenceId"`
		Outcome          struct {
			EvidenceIDs []string `json:"evidenceIds"`
		} `json:"outcome"`
	} `json:"observation"`
	MapBase revisionPointer `json:"mapBase"`
	Context struct {
		States []struct {
			EvidenceHandles []string `json:"evidenceHandles"`
		} `json:"states"`
		Actions []struct {
			ActionID        string   `json:"actionId"`
			EvidenceHandles []string `json:"evidenceHandles"`
			Raw             map[string]any
		} `json:"actions"`
	} `json:"context"`
}

type revisionPointer struct {
	Revision int     `json:"revision"`
	Digest   *string `json:"digest"`
}

type patchFixture struct {
	SchemaVersion  string          `json:"schemaVersion"`
	PatchID        string          `json:"patchId"`
	RequestID      string          `json:"requestId"`
	IdempotencyKey string          `json:"idempotencyKey"`
	SiteScopeID    string          `json:"siteScopeId"`
	LayerSequence  int             `json:"layerSequence"`
	MapBase        revisionPointer `json:"mapBase"`
	Operations     []struct {
		Operation          string          `json:"op"`
		EntityID           string          `json:"entityId"`
		State              json.RawMessage `json:"state"`
		Action             json.RawMessage `json:"action"`
		Provenance         string          `json:"provenance"`
		ComponentActionIDs []string        `json:"componentActionIds"`
		CitationIDs        []string        `json:"citationIds"`
		StepEvidence       []struct {
			StepIndex  int     `json:"stepIndex"`
			Role       string  `json:"role"`
			EvidenceID string  `json:"evidenceId"`
			LayerID    string  `json:"layerId"`
			FieldName  *string `json:"fieldName"`
		} `json:"stepEvidence"`
	} `json:"operations"`
	EvidenceCitations []struct {
		CitationID string `json:"citationId"`
		EvidenceID string `json:"evidenceId"`
	} `json:"evidenceCitations"`
}

type revisionFixture struct {
	SchemaVersion  string `json:"schemaVersion"`
	RequestID      string `json:"requestId"`
	PatchID        string `json:"patchId"`
	IdempotencyKey string `json:"idempotencyKey"`
	SiteScopeID    string `json:"siteScopeId"`
	Application    struct {
		Status string          `json:"status"`
		Base   revisionPointer `json:"base"`
		Result revisionPointer `json:"result"`
	} `json:"application"`
	Storage struct {
		ActionMapRevisionStored    bool `json:"actionMapRevisionStored"`
		SemanticXMLStored          bool `json:"semanticXmlStored"`
		SanitizedObservationStored bool `json:"sanitizedObservationStored"`
		RawObservationStored       bool `json:"rawObservationStored"`
	} `json:"storage"`
}

func TestAmbientContractDocumentsAreValidJSON(t *testing.T) {
	paths := []string{
		"documentation/contracts/ambient-parse-request.schema.json",
		"documentation/contracts/action-map-patch.schema.json",
		"documentation/contracts/action-map-revision.schema.json",
		"documentation/contracts/examples/x-posts.layer-001.parse-request.json",
		"documentation/contracts/examples/x-posts.layer-001.patch.json",
		"documentation/contracts/examples/x-posts.layer-001.revision.json",
		"documentation/contracts/examples/orders.layer-001.parse-request.json",
		"documentation/contracts/examples/orders.layer-001.patch.json",
		"documentation/contracts/examples/orders.layer-001.revision.json",
		"documentation/contracts/examples/orders.layer-002.parse-request.json",
		"documentation/contracts/examples/orders.layer-002.patch.json",
		"documentation/contracts/examples/orders.layer-002.revision.json",
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			contents := readFile(t, path)
			if !json.Valid(contents) {
				t.Fatalf("%s is not valid JSON", path)
			}
		})
	}
}

func TestAmbientFixturesBindEveryExecutableActionToEvidence(t *testing.T) {
	cases := []string{
		"x-posts.layer-001",
		"orders.layer-001",
		"orders.layer-002",
	}
	for _, fixture := range cases {
		t.Run(fixture, func(t *testing.T) {
			request := loadParseFixture(t, fixture)
			patch := loadPatchFixture(t, fixture)
			assertRequestPatchBinding(t, request, patch)
			assertCompactContext(t, fixture)
			assertExecutableEvidence(t, request, patch)
		})
	}
}

func TestAmbientPatchesMaterializeValidActionMapOneDocuments(t *testing.T) {
	xMap := emptyMap("https://x.com")
	applyPatch(t, &xMap, loadPatchFixture(t, "x-posts.layer-001"))
	if err := xMap.Validate(); err != nil {
		t.Fatalf("X patch did not materialize a valid action-map/1: %v", err)
	}
	assertAction(t, xMap, "open_posts", "resolvable", 1)
	assertAction(t, xMap, "get_recent_posts", "resolvable", 1)

	ordersMap := emptyMap("https://shop.example")
	applyPatch(t, &ordersMap, loadPatchFixture(t, "orders.layer-001"))
	if err := ordersMap.Validate(); err != nil {
		t.Fatalf("Orders layer 1 did not materialize a valid action-map/1: %v", err)
	}
	assertAction(t, ordersMap, "open_orders", "resolvable", 1)

	applyPatch(t, &ordersMap, loadPatchFixture(t, "orders.layer-002"))
	if err := ordersMap.Validate(); err != nil {
		t.Fatalf("Orders layer 2 did not materialize a valid action-map/1: %v", err)
	}
	assertAction(t, ordersMap, "open_orders", "observed", 1)
	assertAction(t, ordersMap, "get_recent_orders", "resolvable", 1)
	assertAction(t, ordersMap, "get_orders_from_account", "observed", 3)
}

func TestAmbientSemanticRulesRejectNonExecutableOrUnboundActions(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*patchFixture)
	}{
		{
			name: "zero steps",
			mutate: func(patch *patchFixture) {
				patch.Operations[1].Action = replaceActionField(t, patch.Operations[1].Action, "steps", []any{})
			},
		},
		{
			name: "invented evidence",
			mutate: func(patch *patchFixture) {
				patch.Operations[1].StepEvidence[0].EvidenceID = "node_not_captured"
			},
		},
		{
			name: "click without target binding",
			mutate: func(patch *patchFixture) {
				patch.Operations[1].StepEvidence = nil
			},
		},
		{
			name: "output field without binding",
			mutate: func(patch *patchFixture) {
				for index := range patch.Operations[2].StepEvidence {
					binding := patch.Operations[2].StepEvidence[index]
					if binding.FieldName != nil && *binding.FieldName == "author" {
						patch.Operations[2].StepEvidence = append(
							patch.Operations[2].StepEvidence[:index],
							patch.Operations[2].StepEvidence[index+1:]...,
						)
						return
					}
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := loadParseFixture(t, "x-posts.layer-001")
			patch := loadPatchFixture(t, "x-posts.layer-001")
			test.mutate(&patch)
			if semanticViolation(request, patch) == "" {
				t.Fatal("expected ambient semantic validation to reject mutated patch")
			}
		})
	}
}

func TestAmbientRevisionChainIsIdempotencyAndStorageSafe(t *testing.T) {
	firstRequest := loadParseFixture(t, "orders.layer-001")
	firstPatch := loadPatchFixture(t, "orders.layer-001")
	firstRevision := loadRevisionFixture(t, "orders.layer-001")
	secondRequest := loadParseFixture(t, "orders.layer-002")
	secondPatch := loadPatchFixture(t, "orders.layer-002")
	secondRevision := loadRevisionFixture(t, "orders.layer-002")

	assertReceiptBinding(t, firstRequest, firstPatch, firstRevision)
	assertReceiptBinding(t, secondRequest, secondPatch, secondRevision)
	if firstRevision.Application.Result.Revision != secondRequest.MapBase.Revision ||
		!sameDigest(firstRevision.Application.Result.Digest, secondRequest.MapBase.Digest) {
		t.Fatal("layer 2 does not consume the exact revision 1 result")
	}
	if secondRevision.Application.Base.Revision != firstRevision.Application.Result.Revision ||
		!sameDigest(secondRevision.Application.Base.Digest, firstRevision.Application.Result.Digest) {
		t.Fatal("revision 2 does not compare against the exact revision 1 base")
	}
}

func assertRequestPatchBinding(t *testing.T, request parseFixture, patch patchFixture) {
	t.Helper()
	if request.SchemaVersion != "ambient-parse-request/1" ||
		patch.SchemaVersion != "action-map-patch/1" {
		t.Fatal("unexpected ambient contract version")
	}
	if request.RequestID != patch.RequestID || request.IdempotencyKey != patch.IdempotencyKey ||
		request.SiteScope.ScopeID != patch.SiteScopeID || request.Layer.Sequence != patch.LayerSequence ||
		request.MapBase.Revision != patch.MapBase.Revision ||
		!sameDigest(request.MapBase.Digest, patch.MapBase.Digest) {
		t.Fatal("parse request and patch binding mismatch")
	}
}

func assertCompactContext(t *testing.T, fixture string) {
	t.Helper()
	var document map[string]any
	readJSON(t, examplePath(fixture+".parse-request.json"), &document)
	if _, exists := document["goal"]; exists {
		t.Fatal("ambient parse request contains a goal")
	}
	context, ok := document["context"].(map[string]any)
	if !ok {
		t.Fatal("parse request has no context object")
	}
	forbidden := map[string]bool{
		"steps": true, "step": true, "locator": true, "locators": true,
		"target": true, "semanticXml": true, "observation": true, "goal": true,
	}
	if path := findForbiddenKey(context, forbidden, "context"); path != "" {
		t.Fatalf("compact context expands forbidden field %s", path)
	}
}

func assertExecutableEvidence(t *testing.T, request parseFixture, patch patchFixture) {
	t.Helper()
	if violation := semanticViolation(request, patch); violation != "" {
		t.Fatal(violation)
	}
	knownEvidence := make(map[string]bool)
	for _, evidenceID := range request.Layer.EvidenceIDs {
		knownEvidence[evidenceID] = true
	}
	for _, state := range request.Context.States {
		for _, evidenceID := range state.EvidenceHandles {
			knownEvidence[evidenceID] = true
		}
	}
	for _, action := range request.Context.Actions {
		for _, evidenceID := range action.EvidenceHandles {
			knownEvidence[evidenceID] = true
		}
	}
	if request.Observation != nil {
		knownEvidence[request.Observation.ObservationID] = true
		if request.Observation.TargetEvidenceID != nil {
			knownEvidence[*request.Observation.TargetEvidenceID] = true
		}
		for _, evidenceID := range request.Observation.Outcome.EvidenceIDs {
			knownEvidence[evidenceID] = true
		}
	}

	citations := make(map[string]string)
	for _, citation := range patch.EvidenceCitations {
		if citations[citation.CitationID] != "" {
			t.Fatalf("duplicate citation %s", citation.CitationID)
		}
		if !knownEvidence[citation.EvidenceID] {
			t.Fatalf("citation %s invents evidence %s", citation.CitationID, citation.EvidenceID)
		}
		citations[citation.CitationID] = citation.EvidenceID
	}

	for _, operation := range patch.Operations {
		for _, citationID := range operation.CitationIDs {
			if citations[citationID] == "" {
				t.Fatalf("%s references unknown citation %s", operation.EntityID, citationID)
			}
		}
		if operation.Operation != "upsert_action" {
			continue
		}
		var action actionmap.Action
		if err := json.Unmarshal(operation.Action, &action); err != nil {
			t.Fatalf("decode action %s: %v", operation.EntityID, err)
		}
	}
}

func semanticViolation(request parseFixture, patch patchFixture) string {
	knownEvidence := make(map[string]bool)
	for _, evidenceID := range request.Layer.EvidenceIDs {
		knownEvidence[evidenceID] = true
	}
	for _, state := range request.Context.States {
		for _, evidenceID := range state.EvidenceHandles {
			knownEvidence[evidenceID] = true
		}
	}
	for _, action := range request.Context.Actions {
		for _, evidenceID := range action.EvidenceHandles {
			knownEvidence[evidenceID] = true
		}
	}
	if request.Observation != nil {
		knownEvidence[request.Observation.ObservationID] = true
		if request.Observation.TargetEvidenceID != nil {
			knownEvidence[*request.Observation.TargetEvidenceID] = true
		}
		for _, evidenceID := range request.Observation.Outcome.EvidenceIDs {
			knownEvidence[evidenceID] = true
		}
	}

	for _, operation := range patch.Operations {
		if operation.Operation != "upsert_action" {
			continue
		}
		var action actionmap.Action
		if err := json.Unmarshal(operation.Action, &action); err != nil {
			return "action " + operation.EntityID + " is not valid JSON"
		}
		if action.ID != operation.EntityID || len(action.Steps) == 0 ||
			action.Status == "unresolved" || len(action.MissingEvidence) != 0 {
			return "action " + operation.EntityID + " is not an executable ambient candidate"
		}
		bindingText := strings.Join(action.Evidence, "\n")
		for _, binding := range operation.StepEvidence {
			if binding.StepIndex < 0 || binding.StepIndex >= len(action.Steps) {
				return "action " + operation.EntityID + " binding has invalid step index"
			}
			if !knownEvidence[binding.EvidenceID] || !strings.Contains(bindingText, binding.EvidenceID) {
				return "action " + operation.EntityID + " does not retain known evidence " + binding.EvidenceID
			}
		}
		for index, step := range action.Steps {
			if step.Operation == "click" && !hasBinding(operation.StepEvidence, index, "target", "") {
				return "action " + operation.EntityID + " click has no target evidence"
			}
		}
		if action.Output.Mode != "none" {
			for _, field := range action.Output.Fields {
				if !hasFieldBinding(operation.StepEvidence, field.Name) {
					return "action " + operation.EntityID + " output has no field evidence for " + field.Name
				}
			}
		}
	}
	return ""
}

func assertReceiptBinding(
	t *testing.T,
	request parseFixture,
	patch patchFixture,
	revision revisionFixture,
) {
	t.Helper()
	if revision.SchemaVersion != "action-map-revision/1" ||
		revision.Application.Status != "applied" ||
		revision.RequestID != request.RequestID || revision.PatchID != patch.PatchID ||
		revision.IdempotencyKey != request.IdempotencyKey ||
		revision.SiteScopeID != request.SiteScope.ScopeID ||
		revision.Application.Base.Revision != request.MapBase.Revision ||
		!sameDigest(revision.Application.Base.Digest, request.MapBase.Digest) {
		t.Fatal("revision receipt is not bound to its exact request and base")
	}
	if !revision.Storage.ActionMapRevisionStored || revision.Storage.SemanticXMLStored ||
		revision.Storage.SanitizedObservationStored || revision.Storage.RawObservationStored {
		t.Fatal("revision receipt violates the Universal DB storage boundary")
	}
}

func applyPatch(t *testing.T, actionMap *actionmap.Map, patch patchFixture) {
	t.Helper()
	for _, operation := range patch.Operations {
		switch operation.Operation {
		case "upsert_state":
			var state actionmap.State
			if err := json.Unmarshal(operation.State, &state); err != nil {
				t.Fatalf("decode state %s: %v", operation.EntityID, err)
			}
			actionMap.States = upsertState(actionMap.States, state)
		case "upsert_action":
			var action actionmap.Action
			if err := json.Unmarshal(operation.Action, &action); err != nil {
				t.Fatalf("decode action %s: %v", operation.EntityID, err)
			}
			actionMap.Actions = upsertAction(actionMap.Actions, action)
		default:
			t.Fatalf("unsupported fixture operation %s", operation.Operation)
		}
	}
}

func upsertState(states []actionmap.State, next actionmap.State) []actionmap.State {
	for index := range states {
		if states[index].ID == next.ID {
			states[index] = next
			return states
		}
	}
	return append(states, next)
}

func upsertAction(actions []actionmap.Action, next actionmap.Action) []actionmap.Action {
	for index := range actions {
		if actions[index].ID == next.ID {
			actions[index] = next
			return actions
		}
	}
	return append(actions, next)
}

func emptyMap(origin string) actionmap.Map {
	return actionmap.Map{
		SchemaVersion: actionmap.SchemaVersion,
		Site:          actionmap.Site{Origin: origin, ObservedURLs: []string{origin}},
		Summary:       "Ambient action map conformance fixture",
		Warnings:      []string{},
		Privacy: actionmap.Privacy{
			RedactionsApplied: 1,
			Categories:        []string{"contract_fixture"},
			Policy:            "Only sanitized semantic evidence and safe metadata are retained.",
		},
	}
}

func assertAction(t *testing.T, actionMap actionmap.Map, id string, status string, steps int) {
	t.Helper()
	for _, action := range actionMap.Actions {
		if action.ID == id {
			if action.Status != status || len(action.Steps) != steps {
				t.Fatalf("action %s has status=%s steps=%d", id, action.Status, len(action.Steps))
			}
			return
		}
	}
	t.Fatalf("action %s was not materialized", id)
}

func hasBinding(bindings []struct {
	StepIndex  int     `json:"stepIndex"`
	Role       string  `json:"role"`
	EvidenceID string  `json:"evidenceId"`
	LayerID    string  `json:"layerId"`
	FieldName  *string `json:"fieldName"`
}, stepIndex int, role string, fieldName string) bool {
	for _, binding := range bindings {
		if binding.StepIndex == stepIndex && binding.Role == role &&
			(fieldName == "" || binding.FieldName != nil && *binding.FieldName == fieldName) {
			return true
		}
	}
	return false
}

func hasFieldBinding(bindings []struct {
	StepIndex  int     `json:"stepIndex"`
	Role       string  `json:"role"`
	EvidenceID string  `json:"evidenceId"`
	LayerID    string  `json:"layerId"`
	FieldName  *string `json:"fieldName"`
}, fieldName string) bool {
	for _, binding := range bindings {
		if binding.Role == "output" && binding.FieldName != nil && *binding.FieldName == fieldName {
			return true
		}
	}
	return false
}

func findForbiddenKey(value any, forbidden map[string]bool, path string) string {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			childPath := path + "." + key
			if forbidden[key] {
				return childPath
			}
			if result := findForbiddenKey(child, forbidden, childPath); result != "" {
				return result
			}
		}
	case []any:
		for index, child := range typed {
			if result := findForbiddenKey(child, forbidden, path+"[]"); result != "" {
				_ = index
				return result
			}
		}
	}
	return ""
}

func sameDigest(left *string, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func replaceActionField(t *testing.T, raw json.RawMessage, field string, value any) json.RawMessage {
	t.Helper()
	var action map[string]any
	if err := json.Unmarshal(raw, &action); err != nil {
		t.Fatalf("decode action for mutation: %v", err)
	}
	action[field] = value
	encoded, err := json.Marshal(action)
	if err != nil {
		t.Fatalf("encode mutated action: %v", err)
	}
	return encoded
}

func loadParseFixture(t *testing.T, fixture string) parseFixture {
	t.Helper()
	var result parseFixture
	readJSON(t, examplePath(fixture+".parse-request.json"), &result)
	return result
}

func loadPatchFixture(t *testing.T, fixture string) patchFixture {
	t.Helper()
	var result patchFixture
	readJSON(t, examplePath(fixture+".patch.json"), &result)
	return result
}

func loadRevisionFixture(t *testing.T, fixture string) revisionFixture {
	t.Helper()
	var result revisionFixture
	readJSON(t, examplePath(fixture+".revision.json"), &result)
	return result
}

func examplePath(name string) string {
	return filepath.Join("documentation", "contracts", "examples", name)
}

func readJSON(t *testing.T, path string, target any) {
	t.Helper()
	if err := json.Unmarshal(readFile(t, path), target); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repository root: %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(repositoryRoot, path))
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return contents
}
