package learning

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"sort"
	"strings"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/privacy"
)

func DecodePatch(raw []byte) (ActionMapPatch, error) {
	var patch ActionMapPatch
	if err := decodeStrict(raw, &patch); err != nil {
		return ActionMapPatch{}, Rejection{Code: "MALFORMED_JSON", Path: "$", Message: err.Error()}
	}
	return patch, nil
}

func ValidateAndMaterialize(request ParseRequest, raw []byte, base actionmap.Map) (MaterializedPatch, error) {
	patch, err := DecodePatch(raw)
	if err != nil {
		return MaterializedPatch{}, err
	}
	return MaterializePatch(request, patch, base)
}

func MaterializePatch(request ParseRequest, patch ActionMapPatch, base actionmap.Map) (MaterializedPatch, error) {
	reject := func(code, path, message string) (MaterializedPatch, error) {
		return MaterializedPatch{}, Rejection{Code: code, Path: path, Message: message}
	}
	if requestRejection := ValidateParseRequest(request); requestRejection != nil {
		return MaterializedPatch{}, *requestRejection
	}
	if patch.SchemaVersion != ActionMapPatchVersion {
		return reject("PATCH_SCHEMA_INVALID", "$.schemaVersion", "schemaVersion must be "+ActionMapPatchVersion)
	}
	if !ambientIdentifier.MatchString(patch.PatchID) {
		return reject("PATCH_ID_INVALID", "$.patchId", "patchId is not a contract identifier")
	}
	if patch.RequestID != request.RequestID {
		return reject("REQUEST_BINDING_MISMATCH", "$.requestId", "patch does not bind to this request")
	}
	if patch.IdempotencyKey != request.IdempotencyKey {
		return reject("REQUEST_BINDING_MISMATCH", "$.idempotencyKey", "patch does not bind to this request key")
	}
	if patch.SiteScopeID != request.SiteScope.ScopeID {
		return reject("SITE_SCOPE_MISMATCH", "$.siteScopeId", "patch site scope differs from the request")
	}
	if patch.LayerSequence != request.Layer.Sequence {
		return reject("LAYER_SEQUENCE_MISMATCH", "$.layerSequence", "patch layer sequence differs from the request")
	}
	if patch.MapBase.Revision != request.MapBase.Revision || !sameDigest(patch.MapBase.Digest, request.MapBase.Digest) {
		return reject("MAP_BASE_MISMATCH", "$.mapBase", "patch was produced for a different map base")
	}
	if patch.Parser.ParserID != request.Parser.ParserID || patch.Parser.ParserVersion != request.Parser.ParserVersion || patch.Parser.PromptVersion != request.Parser.PromptVersion {
		return reject("PARSER_BINDING_MISMATCH", "$.parser", "patch parser identity differs from the request")
	}
	if patch.Decision != "patch" && patch.Decision != "no_change" {
		return reject("DECISION_INVALID", "$.decision", "decision must be patch or no_change")
	}
	if strings.TrimSpace(patch.Summary) == "" {
		return reject("SUMMARY_REQUIRED", "$.summary", "the parse result must explain its decision")
	}
	if patch.Decision == "no_change" && len(patch.Operations) != 0 {
		return reject("NO_CHANGE_HAS_OPERATIONS", "$.operations", "no_change must have no operations")
	}
	if patch.Decision == "patch" && len(patch.Operations) == 0 {
		return reject("PATCH_HAS_NO_OPERATIONS", "$.operations", "patch must contain at least one operation")
	}
	if len(patch.EvidenceCitations) == 0 {
		return reject("CITATION_REQUIRED", "$.evidenceCitations", "every parse result must cite evidence")
	}
	semanticPatch, err := patchSemanticContent(patch)
	if err != nil {
		return reject("PATCH_ENCODING_FAILED", "$", err.Error())
	}
	findings, scanErr := privacy.Scan(semanticPatch)
	if scanErr != nil {
		return reject("PRIVACY_SCAN_FAILED", "$", scanErr.Error())
	}
	if len(findings) > 0 {
		return reject("PRIVATE_LITERAL", findings[0].Path, "patch contains "+findings[0].Category)
	}
	for _, pattern := range promptInjectionPatterns {
		if pattern.Match(semanticPatch) {
			return reject("PROMPT_INJECTION", "$", "instruction-shaped page content was reproduced in the patch")
		}
	}

	citations := make(map[string]EvidenceCitation, len(patch.EvidenceCitations))
	currentNodes, xmlErr := semanticNodes(request.Layer.SemanticXML)
	if xmlErr != nil {
		return reject("SEMANTIC_XML_INVALID", "$.layer.semanticXml", xmlErr.Error())
	}
	for index, citation := range patch.EvidenceCitations {
		path := fmt.Sprintf("$.evidenceCitations[%d]", index)
		if _, exists := citations[citation.CitationID]; exists {
			return reject("DUPLICATE_CITATION", path+".citationId", "citation IDs must be unique")
		}
		if rejection := validateCitation(request, citation, path); rejection != nil {
			return MaterializedPatch{}, *rejection
		}
		if citation.Source == "current_layer" && currentNodes[citation.EvidenceID] == nil {
			return reject("INVENTED_EVIDENCE", path+".evidenceId", "current-layer citation is absent from semantic XML")
		}
		citations[citation.CitationID] = citation
	}

	operations := append([]PatchOperation(nil), patch.Operations...)
	sort.SliceStable(operations, func(i, j int) bool {
		if operations[i].Op != operations[j].Op {
			return operations[i].Op == "upsert_state"
		}
		return operations[i].EntityID < operations[j].EntityID
	})
	seenEntities := map[string]bool{}
	sidecars := map[string][]StepEvidence{}
	for index, operation := range operations {
		path := fmt.Sprintf("$.operations[%d]", index)
		if seenEntities[operation.EntityID] {
			return reject("DUPLICATE_ENTITY_OPERATION", path+".entityId", "an entity may be upserted only once per patch")
		}
		seenEntities[operation.EntityID] = true
		if strings.TrimSpace(operation.Reason) == "" || len(operation.CitationIDs) == 0 {
			return reject("OPERATION_EVIDENCE_REQUIRED", path, "operation reason and citations are required")
		}
		for citationIndex, citationID := range operation.CitationIDs {
			if _, exists := citations[citationID]; !exists {
				return reject("INVENTED_EVIDENCE", fmt.Sprintf("%s.citationIds[%d]", path, citationIndex), "operation references an unknown citation")
			}
		}
		switch operation.Op {
		case "upsert_state":
			if operation.State == nil || operation.Action != nil || len(operation.StepEvidence) != 0 || len(operation.ComponentActionIDs) != 0 {
				return reject("STATE_OPERATION_INVALID", path, "upsert_state must carry only a complete state")
			}
			if operation.EntityID != operation.State.ID {
				return reject("ENTITY_ID_MISMATCH", path+".entityId", "entityId must equal state.id")
			}
			if rejection := validateStateEvidence(*operation.State, operation.CitationIDs, citations, path+".state"); rejection != nil {
				return MaterializedPatch{}, *rejection
			}
		case "upsert_action":
			if operation.Action == nil || operation.State != nil {
				return reject("ACTION_OPERATION_INVALID", path, "upsert_action must carry a complete action")
			}
			if operation.EntityID != operation.Action.ID {
				return reject("ENTITY_ID_MISMATCH", path+".entityId", "entityId must equal action.id")
			}
			if rejection := validateAmbientAction(request, operation, citations, currentNodes, path); rejection != nil {
				return MaterializedPatch{}, *rejection
			}
			sidecars[operation.EntityID] = append([]StepEvidence(nil), operation.StepEvidence...)
		default:
			return reject("UNSUPPORTED_OPERATION", path+".op", "only state and action upserts are supported")
		}
	}

	if patch.Decision == "no_change" {
		if request.MapBase.Revision > 0 {
			if err := base.Validate(); err != nil {
				return reject("BASE_MAP_INVALID", "$base", err.Error())
			}
			digest, err := CanonicalDigest(base)
			if err != nil || request.MapBase.Digest == nil || digest != *request.MapBase.Digest {
				return reject("BASE_DIGEST_MISMATCH", "$.mapBase.digest", "base map digest does not match the requested revision")
			}
			if base.Site.Origin != request.SiteScope.Origin {
				return reject("SITE_SCOPE_MISMATCH", "$base.site.origin", "base map origin differs from request origin")
			}
		}
		return MaterializedPatch{Patch: patch, ActionMap: base, Diagnostics: []Diagnostic{}, Sidecars: sidecars}, nil
	}
	materialized, rejection := applyPatch(request, operations, base)
	if rejection != nil {
		return MaterializedPatch{}, *rejection
	}
	return MaterializedPatch{Patch: patch, ActionMap: materialized, Diagnostics: []Diagnostic{}, Sidecars: sidecars}, nil
}

func patchSemanticContent(patch ActionMapPatch) ([]byte, error) {
	operations := make([]map[string]any, 0, len(patch.Operations))
	for _, operation := range patch.Operations {
		value := map[string]any{"reason": operation.Reason}
		if operation.State != nil {
			state := *operation.State
			state.ID = "state"
			state.Evidence = nil
			value["state"] = state
		}
		if operation.Action != nil {
			action := *operation.Action
			action.ID = "action"
			action.FromState = "state"
			action.ToState = nil
			action.Evidence = nil
			action.MissingEvidence = nil
			value["action"] = action
		}
		operations = append(operations, value)
	}
	return json.Marshal(map[string]any{"summary": patch.Summary, "operations": operations})
}

func validateCitation(request ParseRequest, citation EvidenceCitation, path string) *Rejection {
	reject := func(code, suffix, message string) *Rejection {
		return &Rejection{Code: code, Path: path + suffix, Message: message}
	}
	if !ambientIdentifier.MatchString(citation.CitationID) || !ambientIdentifier.MatchString(citation.EvidenceID) || !ambientIdentifier.MatchString(citation.LayerID) || !digestPattern.MatchString(citation.Digest) {
		return reject("CITATION_INVALID", "", "citation identity, layer, and digest are required")
	}
	current := stringSet(request.Layer.EvidenceIDs)
	prior := priorEvidence(request.Context)
	observation := map[string]bool{}
	if request.Observation != nil {
		observation[request.Observation.ObservationID] = true
		for _, evidenceID := range request.Observation.Outcome.EvidenceIDs {
			observation[evidenceID] = true
		}
		if request.Observation.TargetEvidenceID != nil {
			prior[*request.Observation.TargetEvidenceID] = true
		}
	}
	switch citation.Source {
	case "current_layer":
		if citation.LayerID != request.Layer.LayerID || !current[citation.EvidenceID] || citation.Digest != request.Layer.SemanticXMLDigest {
			return reject("INVENTED_EVIDENCE", ".evidenceId", "current-layer citation does not resolve to the current semantic XML")
		}
		if citation.Kind != "node" {
			return reject("CITATION_KIND_INVALID", ".kind", "current semantic XML establishes node evidence")
		}
	case "observation":
		if request.Observation == nil || citation.LayerID != request.Layer.LayerID || !observation[citation.EvidenceID] {
			return reject("INVENTED_EVIDENCE", ".evidenceId", "observation citation does not resolve to the causal observation")
		}
		if citation.Kind != "event" && citation.Kind != "update" {
			return reject("CITATION_KIND_INVALID", ".kind", "observation evidence must be an event or update")
		}
	case "prior_context":
		if !prior[citation.EvidenceID] {
			return reject("INVENTED_EVIDENCE", ".evidenceId", "prior citation does not resolve to a compact evidence handle")
		}
	case "verification":
		if !verifiedEvidence(request.Context)[citation.EvidenceID] {
			return reject("STALE_VERIFICATION", ".evidenceId", "verification was not supplied by a verified exact prior action")
		}
	default:
		return reject("CITATION_SOURCE_INVALID", ".source", "unsupported evidence source")
	}
	return nil
}

func validateStateEvidence(state actionmap.State, citationIDs []string, citations map[string]EvidenceCitation, path string) *Rejection {
	if len(state.Evidence) == 0 {
		return &Rejection{Code: "EVIDENCE_REQUIRED", Path: path + ".evidence", Message: "state must retain evidence bindings"}
	}
	for index, token := range state.Evidence {
		layerID, evidenceID := tokenEvidence(token)
		if !hasCitedBinding(citationIDs, citations, layerID, evidenceID, "node") {
			return &Rejection{Code: "INVENTED_EVIDENCE", Path: fmt.Sprintf("%s.evidence[%d]", path, index), Message: "state evidence is not cited"}
		}
	}
	return nil
}

func validateAmbientAction(request ParseRequest, operation PatchOperation, citations map[string]EvidenceCitation, currentNodes map[string]*semanticNode, path string) *Rejection {
	action := *operation.Action
	reject := func(code, suffix, message string) *Rejection {
		return &Rejection{Code: code, Path: path + suffix, Message: message}
	}
	if len(action.Steps) == 0 {
		return reject("ZERO_STEP_ACTION", ".action.steps", "every ambient action must be immediately executable")
	}
	if action.Status != "resolvable" && action.Status != "observed" {
		return reject("ACTION_STATUS_INVALID", ".action.status", "ambient actions cannot be unresolved")
	}
	if len(action.MissingEvidence) != 0 {
		return reject("MISSING_EVIDENCE_NOT_EMPTY", ".action.missingEvidence", "executable ambient actions cannot retain missing evidence")
	}
	if operation.Provenance != "inferred" && operation.Provenance != "observed" && operation.Provenance != "verified" {
		return reject("PROVENANCE_INVALID", ".provenance", "unsupported provenance")
	}
	if operation.Provenance == "verified" {
		return reject("STALE_VERIFICATION", ".provenance", "ordinary ambient parses cannot mint or transfer verification to an upsert")
	}
	if operation.Provenance == "inferred" && action.Status != "resolvable" {
		return reject("PROVENANCE_STATUS_MISMATCH", ".action.status", "inferred actions use resolvable status")
	}
	if operation.Provenance == "observed" && action.Status != "observed" {
		return reject("PROVENANCE_STATUS_MISMATCH", ".action.status", "observed actions use observed status")
	}
	for _, prior := range request.Context.Actions {
		if prior.ActionID == action.ID && provenanceRank(operation.Provenance) < provenanceRank(prior.Provenance) {
			return reject("PROVENANCE_DOWNGRADE", ".provenance", "provenance must advance monotonically for the same action")
		}
	}
	hasObservationCitation := false
	for _, citationID := range operation.CitationIDs {
		citation := citations[citationID]
		if citation.Source == "observation" {
			hasObservationCitation = true
		}
		if citation.Source == "verification" {
			return reject("STALE_VERIFICATION", ".citationIds", "verification cannot transfer through an AI action upsert")
		}
	}
	if operation.Provenance == "observed" && !hasObservationCitation {
		return reject("OBSERVATION_EVIDENCE_REQUIRED", ".citationIds", "observed provenance requires causal observation evidence")
	}
	if len(operation.StepEvidence) == 0 || len(action.Evidence) == 0 {
		return reject("EVIDENCE_REQUIRED", ".stepEvidence", "action and normalized step evidence are required")
	}
	bindings := map[string]bool{}
	expectedTokens := map[string]bool{}
	for index, binding := range operation.StepEvidence {
		bindingPath := fmt.Sprintf(".stepEvidence[%d]", index)
		if binding.StepIndex < 0 || binding.StepIndex >= len(action.Steps) {
			return reject("STEP_BINDING_INVALID", bindingPath+".stepIndex", "binding references an absent action step")
		}
		if binding.Role != "target" && binding.Role != "effect" && binding.Role != "output" {
			return reject("STEP_BINDING_INVALID", bindingPath+".role", "binding role is unsupported")
		}
		step := action.Steps[binding.StepIndex]
		if binding.Role != "output" && binding.FieldName != nil {
			return reject("STEP_BINDING_INVALID", bindingPath+".fieldName", "only output-field bindings name a field")
		}
		if binding.Role == "target" && step.Operation != "fill" && step.Operation != "click" && step.Operation != "press" {
			return reject("STEP_BINDING_INVALID", bindingPath+".role", "target binding is attached to a non-interactive step")
		}
		if binding.Role == "effect" && step.Expect.Kind == "none" {
			return reject("STEP_BINDING_INVALID", bindingPath+".role", "effect binding requires a declared expectation")
		}
		if binding.Role == "output" {
			if step.Operation != "extract" {
				return reject("STEP_BINDING_INVALID", bindingPath+".role", "output binding must be attached to an extract step")
			}
			if binding.FieldName != nil && !outputHasField(action.Output, *binding.FieldName) {
				return reject("STEP_BINDING_INVALID", bindingPath+".fieldName", "binding names an absent output field")
			}
		}
		kind := "node"
		if binding.Role == "effect" {
			kind = ""
		}
		if !hasCitedBinding(operation.CitationIDs, citations, binding.LayerID, binding.EvidenceID, kind) {
			return reject("INVENTED_EVIDENCE", bindingPath+".evidenceId", "step binding is not backed by an operation citation")
		}
		if binding.LayerID == request.Layer.LayerID && (binding.Role == "target" || binding.Role == "output") {
			node := currentNodes[binding.EvidenceID]
			if node == nil {
				return reject("EVIDENCE_LOCATOR_MISMATCH", bindingPath+".evidenceId", "binding node is absent from current semantic XML")
			}
			locator := action.Steps[binding.StepIndex].Target
			if binding.Role == "output" {
				locator = outputLocator(action.Output, binding.FieldName)
			}
			if !node.matches(locator) {
				return reject("EVIDENCE_LOCATOR_MISMATCH", bindingPath, "locator does not describe the cited semantic node")
			}
		}
		key := bindingKey(binding.StepIndex, binding.Role, binding.FieldName)
		if bindings[key] {
			return reject("DUPLICATE_STEP_BINDING", bindingPath, "step evidence bindings must be unique")
		}
		bindings[key] = true
		expectedToken := evidenceToken(binding)
		expectedTokens[expectedToken] = true
		if !containsString(action.Evidence, expectedToken) {
			return reject("EVIDENCE_TOKEN_MISSING", ".action.evidence", "action does not retain binding token "+expectedToken)
		}
	}
	for index, step := range action.Steps {
		switch step.Operation {
		case "fill", "click", "press", "wait", "extract":
		default:
			return reject("UNSUPPORTED_PRIMITIVE", fmt.Sprintf(".action.steps[%d].op", index), "ambient actions support only fill, click, press, wait, and extract")
		}
		if step.Operation == "click" && !bindings[bindingKey(index, "target", nil)] {
			return reject("UNBOUND_CLICK", fmt.Sprintf(".action.steps[%d].target", index), "click target must bind to semantic node evidence")
		}
		if (step.Operation == "fill" || step.Operation == "press") && !bindings[bindingKey(index, "target", nil)] {
			return reject("UNBOUND_TARGET", fmt.Sprintf(".action.steps[%d].target", index), "interactive target must bind to semantic node evidence")
		}
		if operation.Provenance == "observed" && step.Expect.Kind != "none" && step.Operation != "extract" && !bindings[bindingKey(index, "effect", nil)] {
			return reject("UNBOUND_EFFECT", fmt.Sprintf(".action.steps[%d].expect", index), "observed effects must bind to causal evidence")
		}
		if step.LiteralValue != nil {
			literal, _ := json.Marshal(*step.LiteralValue)
			findings, _ := privacy.Scan(literal)
			if len(findings) > 0 {
				return reject("PRIVATE_LITERAL", fmt.Sprintf(".action.steps[%d].literalValue", index), "literal contains private material")
			}
		}
	}
	if action.Output.Mode != "none" {
		lastStep := len(action.Steps) - 1
		if action.Steps[lastStep].Operation != "extract" {
			return reject("EXTRACT_STEP_REQUIRED", ".action.steps", "an output action must end in extract")
		}
		if !hasUnqualifiedBinding(bindings, "output") && !hasUnqualifiedBinding(bindings, "effect") {
			return reject("UNBOUND_OUTPUT", ".action.output", "output root must bind to semantic evidence")
		}
		for index, field := range action.Output.Fields {
			name := field.Name
			if !bindings[bindingKey(lastStep, "output", &name)] {
				return reject("UNBOUND_OUTPUT", fmt.Sprintf(".action.output.fields[%d]", index), "output field must bind to semantic evidence")
			}
		}
	}
	components := stringSet(operation.ComponentActionIDs)
	for _, token := range action.Evidence {
		if strings.HasPrefix(token, "component:") {
			if !components[strings.TrimPrefix(token, "component:")] {
				return reject("COMPONENT_BINDING_INVALID", ".action.evidence", "component token is absent from componentActionIds")
			}
			continue
		}
		if !expectedTokens[token] {
			return reject("INVENTED_EVIDENCE", ".action.evidence", "action contains evidence without a normalized sidecar binding")
		}
	}
	return nil
}

// semanticNode is the tiny, intentionally structural view required to prove
// that a locator names the semantic node cited by an ambient patch. It never
// persists XML; parsing happens only at the validation boundary.
type semanticNode struct {
	attrs map[string]string
	text  string
}

func (node semanticNode) matches(locator actionmap.Locator) bool {
	if locator.Role != nil && node.attrs["role"] != *locator.Role {
		return false
	}
	if locator.Name != nil && node.attrs["accessible-name"] != *locator.Name {
		return false
	}
	if locator.Placeholder != nil && node.attrs["placeholder"] != *locator.Placeholder {
		return false
	}
	if locator.HrefContains != nil && !strings.Contains(node.attrs["href"], *locator.HrefContains) {
		return false
	}
	if locator.Text != nil && !strings.Contains(strings.TrimSpace(node.text), *locator.Text) && node.attrs["accessible-name"] != *locator.Text {
		return false
	}
	return true
}

func outputLocator(output actionmap.Output, fieldName *string) actionmap.Locator {
	if fieldName != nil {
		for _, field := range output.Fields {
			if field.Name == *fieldName {
				return field.Locator
			}
		}
	}
	if output.CollectionRoot.HasEvidence() {
		return output.CollectionRoot
	}
	return output.Item
}

func semanticNodes(source string) (map[string]*semanticNode, error) {
	decoder := xml.NewDecoder(strings.NewReader(source))
	nodes := map[string]*semanticNode{}
	var stack []*semanticNode
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return nodes, nil
		}
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			node := &semanticNode{attrs: map[string]string{}}
			for _, attr := range value.Attr {
				node.attrs[attr.Name.Local] = attr.Value
			}
			if ref := node.attrs["ref"]; ref != "" {
				nodes[ref] = node
			}
			stack = append(stack, node)
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].text += string(value)
			}
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
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

func outputHasField(output actionmap.Output, name string) bool {
	for _, field := range output.Fields {
		if field.Name == name {
			return true
		}
	}
	return false
}

func hasUnqualifiedBinding(bindings map[string]bool, role string) bool {
	suffix := ":" + role + ":"
	for key := range bindings {
		if strings.HasSuffix(key, suffix) {
			return true
		}
	}
	return false
}

func applyPatch(request ParseRequest, operations []PatchOperation, base actionmap.Map) (actionmap.Map, *Rejection) {
	if request.MapBase.Revision == 0 {
		base = actionmap.Map{
			SchemaVersion: actionmap.SchemaVersion,
			Site:          actionmap.Site{Origin: request.SiteScope.Origin, ObservedURLs: []string{}},
			Summary:       "Ambient actions for " + request.SiteScope.ScopeID,
			States:        []actionmap.State{}, Actions: []actionmap.Action{}, Warnings: []string{},
			Privacy: actionmap.Privacy{Categories: []string{}, Policy: "Policy-gated semantic sanitization before model transfer."},
		}
	} else {
		if err := base.Validate(); err != nil {
			return actionmap.Map{}, &Rejection{Code: "BASE_MAP_INVALID", Path: "$base", Message: err.Error()}
		}
		digest, _ := CanonicalDigest(base)
		if request.MapBase.Digest == nil || digest != *request.MapBase.Digest {
			return actionmap.Map{}, &Rejection{Code: "BASE_DIGEST_MISMATCH", Path: "$.mapBase.digest", Message: "base map digest does not match the requested revision"}
		}
		encoded, err := json.Marshal(base)
		if err != nil {
			return actionmap.Map{}, &Rejection{Code: "BASE_MAP_INVALID", Path: "$base", Message: err.Error()}
		}
		var cloned actionmap.Map
		if err := json.Unmarshal(encoded, &cloned); err != nil {
			return actionmap.Map{}, &Rejection{Code: "BASE_MAP_INVALID", Path: "$base", Message: err.Error()}
		}
		base = cloned
	}
	if base.Site.Origin != request.SiteScope.Origin {
		return actionmap.Map{}, &Rejection{Code: "SITE_SCOPE_MISMATCH", Path: "$base.site.origin", Message: "base map origin differs from request origin"}
	}
	base.Site.ObservedURLs = appendRecentURL(base.Site.ObservedURLs, request.Layer.URL)
	base.Privacy.RedactionsApplied += request.Privacy.RedactionCount
	base.Privacy.Categories = unionSorted(base.Privacy.Categories, request.Privacy.Categories)
	states := make(map[string]actionmap.State, len(base.States))
	for _, state := range base.States {
		states[state.ID] = state
	}
	actions := make(map[string]actionmap.Action, len(base.Actions))
	for _, action := range base.Actions {
		actions[action.ID] = action
	}
	for _, operation := range operations {
		if operation.State != nil {
			states[operation.EntityID] = *operation.State
		}
		if operation.Action != nil {
			actions[operation.EntityID] = *operation.Action
		}
	}
	base.States = base.States[:0]
	for _, state := range states {
		base.States = append(base.States, state)
	}
	base.Actions = base.Actions[:0]
	for _, action := range actions {
		base.Actions = append(base.Actions, action)
	}
	sort.Slice(base.States, func(i, j int) bool { return base.States[i].ID < base.States[j].ID })
	sort.Slice(base.Actions, func(i, j int) bool { return base.Actions[i].ID < base.Actions[j].ID })
	if err := base.Validate(); err != nil {
		return actionmap.Map{}, &Rejection{Code: "ACTION_MAP_INVALID", Path: "$materialized", Message: err.Error()}
	}
	return base, nil
}

func sameDigest(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func priorEvidence(context CompactContext) map[string]bool {
	result := map[string]bool{}
	for _, state := range context.States {
		for _, handle := range state.EvidenceHandles {
			result[handle] = true
		}
	}
	for _, action := range context.Actions {
		for _, handle := range action.EvidenceHandles {
			result[handle] = true
		}
	}
	return result
}

func verifiedEvidence(context CompactContext) map[string]bool {
	result := map[string]bool{}
	for _, action := range context.Actions {
		if action.Provenance != "verified" {
			continue
		}
		for _, handle := range action.EvidenceHandles {
			result[handle] = true
		}
	}
	return result
}

func tokenEvidence(token string) (string, string) {
	parts := strings.Split(token, ":")
	if len(parts) >= 2 {
		return parts[0], parts[1]
	}
	return "", token
}

func hasCitedBinding(ids []string, citations map[string]EvidenceCitation, layerID, evidenceID, kind string) bool {
	for _, id := range ids {
		citation := citations[id]
		if citation.LayerID == layerID && citation.EvidenceID == evidenceID && (kind == "" || citation.Kind == kind) {
			return true
		}
	}
	return false
}

func bindingKey(step int, role string, field *string) string {
	value := fmt.Sprintf("%d:%s:", step, role)
	if field != nil {
		value += *field
	}
	return value
}

func evidenceToken(binding StepEvidence) string {
	suffix := fmt.Sprintf("step_%d_%s", binding.StepIndex, binding.Role)
	if binding.FieldName != nil {
		suffix = "field_" + *binding.FieldName
	}
	return binding.LayerID + ":" + binding.EvidenceID + ":" + suffix
}

func appendRecentURL(values []string, current string) []string {
	for _, value := range values {
		if value == current {
			return values
		}
	}
	values = append(values, current)
	if len(values) > 12 {
		values = values[len(values)-12:]
	}
	return values
}

func unionSorted(left, right []string) []string {
	set := stringSet(left)
	for _, value := range right {
		set[value] = true
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
