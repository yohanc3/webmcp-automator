package learning

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"webmcp-automator/server/internal/actionmap"
)

var (
	ambientIdentifier       = regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,127}$`)
	digestPattern           = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	promptInjectionPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)ignore\s+(all\s+)?(previous|prior|system)\s+instructions?`),
		regexp.MustCompile(`(?i)(system|developer)\s+message\s*:`),
		regexp.MustCompile(`(?i)reveal\s+(the\s+)?(system\s+)?prompt`),
		regexp.MustCompile(`(?i)disregard\s+(all\s+)?(previous|prior)\s+instructions?`),
	}
)

type ContextProvenance struct {
	States  map[string]string
	Actions map[string]string
}

func DefaultParserProfile() ParserProfile {
	return ParserProfile{
		ParserID: AmbientParserID, ParserVersion: AmbientParserVersion,
		PromptVersion: AmbientPromptVersion, OutputSchemaVersion: ActionMapPatchVersion,
	}
}

func AssembleParseRequest(completed CompletedLayer, base MapBase, context CompactContext, profile ParserProfile, identity RequestIdentity) (ParseRequest, error) {
	if profile.ParserID == "" {
		profile = DefaultParserProfile()
	}
	request := ParseRequest{
		SchemaVersion: AmbientParseRequestVersion,
		RequestID:     identity.RequestID,
		Attempt:       identity.Attempt,
		RetryOf:       identity.RetryOf,
		SiteScope:     completed.SiteScope,
		Layer:         completed.Layer,
		Observation:   completed.Observation,
		MapBase:       base,
		Context:       context,
		Parser:        profile,
		Policy:        completed.Policy,
		Privacy:       completed.Privacy,
	}
	if request.Attempt == 0 {
		request.Attempt = 1
	}
	request.IdempotencyKey = requestIdempotencyKey(request)
	if rejection := ValidateParseRequest(request); rejection != nil {
		return ParseRequest{}, *rejection
	}
	return request, nil
}

func DecodeParseRequest(raw []byte) (ParseRequest, error) {
	var request ParseRequest
	if err := decodeStrict(raw, &request); err != nil {
		return ParseRequest{}, Rejection{Code: "MALFORMED_REQUEST", Path: "$", Message: err.Error()}
	}
	if rejection := ValidateParseRequest(request); rejection != nil {
		return ParseRequest{}, *rejection
	}
	return request, nil
}

func ValidateParseRequest(request ParseRequest) *Rejection {
	reject := func(code, path, message string) *Rejection {
		return &Rejection{Code: code, Path: path, Message: message}
	}
	if request.SchemaVersion != AmbientParseRequestVersion {
		return reject("REQUEST_SCHEMA_INVALID", "$.schemaVersion", "schemaVersion must be "+AmbientParseRequestVersion)
	}
	if !ambientIdentifier.MatchString(request.RequestID) {
		return reject("REQUEST_ID_INVALID", "$.requestId", "requestId is not a contract identifier")
	}
	if request.Attempt < 1 || request.Attempt > 20 {
		return reject("REQUEST_ATTEMPT_INVALID", "$.attempt", "attempt must be between 1 and 20")
	}
	if request.RetryOf != nil && !ambientIdentifier.MatchString(*request.RetryOf) {
		return reject("RETRY_ID_INVALID", "$.retryOf", "retryOf is not a contract identifier")
	}
	if !ambientIdentifier.MatchString(request.SiteScope.ScopeID) {
		return reject("SITE_SCOPE_INVALID", "$.siteScope.scopeId", "scopeId is not a contract identifier")
	}
	origin, err := url.Parse(request.SiteScope.Origin)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.Path != "" {
		return reject("SITE_SCOPE_INVALID", "$.siteScope.origin", "origin must be an HTTP or HTTPS origin without a path")
	}
	if origin.Scheme != "http" && origin.Scheme != "https" {
		return reject("SITE_SCOPE_INVALID", "$.siteScope.origin", "origin must use HTTP or HTTPS")
	}
	if len(request.SiteScope.RoutePatterns) == 0 {
		return reject("SITE_SCOPE_INVALID", "$.siteScope.routePatterns", "at least one route pattern is required")
	}
	for index, pattern := range request.SiteScope.RoutePatterns {
		if _, err := regexp.Compile(pattern); err != nil {
			return reject("SITE_SCOPE_INVALID", fmt.Sprintf("$.siteScope.routePatterns[%d]", index), "route pattern is not valid regular expression")
		}
	}
	if request.Layer.SemanticXMLVersion != "semantic-ui/2" {
		return reject("SEMANTIC_XML_VERSION_INVALID", "$.layer.semanticXmlVersion", "semantic XML must use semantic-ui/2")
	}
	if request.Layer.Sequence < 1 || request.Layer.LayerID == "" || len(request.Layer.EvidenceIDs) == 0 {
		return reject("LAYER_INVALID", "$.layer", "layer identity, sequence, and evidence are required")
	}
	layerURL, err := url.Parse(request.Layer.URL)
	if err != nil || layerURL.Scheme+"://"+layerURL.Host != request.SiteScope.Origin {
		return reject("LAYER_URL_OUT_OF_SCOPE", "$.layer.url", "layer URL must belong to the normalized site origin")
	}
	seenEvidence := map[string]bool{}
	for index, evidenceID := range request.Layer.EvidenceIDs {
		if !ambientIdentifier.MatchString(evidenceID) || seenEvidence[evidenceID] {
			return reject("LAYER_EVIDENCE_INVALID", fmt.Sprintf("$.layer.evidenceIds[%d]", index), "layer evidence IDs must be unique contract identifiers")
		}
		seenEvidence[evidenceID] = true
	}
	if xmlDigest(request.Layer.SemanticXML) != request.Layer.SemanticXMLDigest {
		return reject("SEMANTIC_XML_DIGEST_MISMATCH", "$.layer.semanticXmlDigest", "digest does not match the exact semantic XML bytes")
	}
	if err := validateSemanticXML(request.Layer.SemanticXML, request.Layer.EvidenceIDs); err != nil {
		return reject("SEMANTIC_XML_INVALID", "$.layer.semanticXml", err.Error())
	}
	for _, pattern := range promptInjectionPatterns {
		if pattern.MatchString(request.Layer.SemanticXML) {
			return reject("PROMPT_INJECTION", "$.layer.semanticXml", "page text contains an instruction-shaped prompt injection")
		}
	}
	if request.Layer.Sequence == 1 && request.Observation != nil {
		return reject("CAUSAL_ORDER_INVALID", "$.observation", "the initial layer must not carry an observation")
	}
	if request.Layer.Sequence > 1 && request.Observation == nil {
		return reject("CAUSAL_ORDER_INVALID", "$.observation", "every later layer must carry its one causal observation")
	}
	if request.Observation != nil {
		observation := request.Observation
		if !ambientIdentifier.MatchString(observation.ObservationID) || observation.EventSequence < 1 || !ambientIdentifier.MatchString(observation.FromLayerID) || observation.FromLayerID == request.Layer.LayerID {
			return reject("CAUSAL_ORDER_INVALID", "$.observation", "observation identity and prior layer are invalid")
		}
		if len(observation.Outcome.EvidenceIDs) == 0 {
			return reject("CAUSAL_ORDER_INVALID", "$.observation.outcome.evidenceIds", "observation outcome evidence is required")
		}
		if observation.TargetEvidenceID != nil {
			available := priorEvidence(request.Context)
			for _, evidenceID := range request.Layer.EvidenceIDs {
				available[evidenceID] = true
			}
			if !available[*observation.TargetEvidenceID] {
				return reject("INVENTED_EVIDENCE", "$.observation.targetEvidenceId", "observation target does not resolve to current or prior semantic evidence")
			}
		}
	}
	if request.Policy.Status != "allowed" || request.Policy.Scope != "ambient_learn" || request.Policy.DecisionID == "" {
		return reject("POLICY_NOT_ALLOWED", "$.policy", "a current allowed ambient_learn decision is required")
	}
	if request.Privacy.RawPersisted {
		return reject("RAW_MATERIAL_FORBIDDEN", "$.privacy.rawPersisted", "raw material must not be persisted")
	}
	if request.Privacy.RedactionCount < 0 || !digestPattern.MatchString(request.Privacy.RedactionDigest) {
		return reject("PRIVACY_SUMMARY_INVALID", "$.privacy", "privacy summary is invalid")
	}
	if request.MapBase.Revision == 0 {
		if request.MapBase.Digest != nil || request.MapBase.PreviousLayerSequence != 0 {
			return reject("MAP_BASE_INVALID", "$.mapBase", "revision zero must have a null digest and zero prior layer sequence")
		}
	} else if request.MapBase.Digest == nil || !digestPattern.MatchString(*request.MapBase.Digest) || request.MapBase.PreviousLayerSequence < 1 {
		return reject("MAP_BASE_INVALID", "$.mapBase", "a nonzero base requires a digest and prior layer sequence")
	}
	if request.Layer.Sequence <= request.MapBase.PreviousLayerSequence {
		return reject("LAYER_SEQUENCE_STALE", "$.layer.sequence", "layer sequence must follow the exact map base")
	}
	if request.Parser.ParserID == "" || request.Parser.ParserVersion == "" || request.Parser.PromptVersion == "" || request.Parser.OutputSchemaVersion != ActionMapPatchVersion {
		return reject("PARSER_PROFILE_INVALID", "$.parser", "parser profile is incomplete or requests the wrong output schema")
	}
	if request.IdempotencyKey != requestIdempotencyKey(request) {
		return reject("IDEMPOTENCY_KEY_INVALID", "$.idempotencyKey", "idempotency key does not match the canonical request tuple")
	}
	if encoded, err := json.Marshal(request.Context); err != nil {
		return reject("CONTEXT_INVALID", "$.context", err.Error())
	} else {
		for _, forbidden := range []string{"steps", "locators", "semanticXml", "observation", "targetEvidenceId"} {
			if bytes.Contains(encoded, []byte(`"`+forbidden+`"`)) {
				return reject("CONTEXT_EXPANDED", "$.context", "compact context contains "+forbidden)
			}
		}
	}
	stateIDs := map[string]bool{}
	for index, state := range request.Context.States {
		if !ambientIdentifier.MatchString(state.StateID) || stateIDs[state.StateID] || strings.TrimSpace(state.Label) == "" || strings.TrimSpace(state.RoutePattern) == "" || len(state.EvidenceHandles) == 0 {
			return reject("CONTEXT_INVALID", fmt.Sprintf("$.context.states[%d]", index), "compact state identity, semantics, and evidence are required")
		}
		stateIDs[state.StateID] = true
	}
	actionIDs := map[string]bool{}
	for index, action := range request.Context.Actions {
		if !ambientIdentifier.MatchString(action.ActionID) || actionIDs[action.ActionID] || strings.TrimSpace(action.Title) == "" || strings.TrimSpace(action.Precondition) == "" || strings.TrimSpace(action.Effect) == "" || len(action.EvidenceHandles) == 0 {
			return reject("CONTEXT_INVALID", fmt.Sprintf("$.context.actions[%d]", index), "compact action identity, semantics, and evidence are required")
		}
		if action.Provenance != "inferred" && action.Provenance != "observed" && action.Provenance != "verified" {
			return reject("CONTEXT_INVALID", fmt.Sprintf("$.context.actions[%d].provenance", index), "compact provenance is invalid")
		}
		actionIDs[action.ActionID] = true
	}
	return nil
}

func ProjectCompactContext(actionMap actionmap.Map, provenance ContextProvenance) CompactContext {
	context := CompactContext{States: []CompactState{}, Actions: []CompactAction{}}
	stateLabels := make(map[string]string, len(actionMap.States))
	for _, state := range actionMap.States {
		stateLabels[state.ID] = state.Label
		context.States = append(context.States, CompactState{
			StateID: state.ID, Label: state.Label, RoutePattern: state.URLPattern,
			EvidenceHandles: evidenceHandles(state.Evidence),
		})
	}
	for _, action := range actionMap.Actions {
		inputs := make([]CompactInput, 0, len(action.Parameters))
		for _, parameter := range action.Parameters {
			inputs = append(inputs, CompactInput{Name: parameter.Name, Type: parameter.Type, Required: parameter.Required})
		}
		fields := make([]string, 0, len(action.Output.Fields))
		for _, field := range action.Output.Fields {
			fields = append(fields, field.Name)
		}
		fromLabel := stateLabels[action.FromState]
		if fromLabel == "" {
			fromLabel = action.FromState
		}
		effect := "Remain in the current semantic state."
		if action.ToState != nil {
			toLabel := stateLabels[*action.ToState]
			if toLabel == "" {
				toLabel = *action.ToState
			}
			effect = "Reach " + toLabel + "."
		} else if action.Output.Mode != "none" {
			effect = "Return the declared " + action.Output.Mode + " output."
		}
		level := "inferred"
		if provenance.Actions != nil && provenance.Actions[action.ID] != "" {
			level = provenance.Actions[action.ID]
		}
		context.Actions = append(context.Actions, CompactAction{
			ActionID: action.ID, Title: action.Name,
			Precondition: fromLabel + " is visible.", Effect: effect,
			Inputs: inputs, Output: CompactOutput{Mode: action.Output.Mode, Fields: fields},
			EvidenceHandles: evidenceHandles(action.Evidence), Provenance: level,
		})
	}
	sort.Slice(context.States, func(i, j int) bool { return context.States[i].StateID < context.States[j].StateID })
	sort.Slice(context.Actions, func(i, j int) bool { return context.Actions[i].ActionID < context.Actions[j].ActionID })
	return context
}

func evidenceHandles(tokens []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, token := range tokens {
		if strings.HasPrefix(token, "component:") {
			continue
		}
		parts := strings.Split(token, ":")
		handle := token
		if len(parts) >= 2 {
			handle = parts[1]
		}
		if ambientIdentifier.MatchString(handle) && !seen[handle] {
			seen[handle] = true
			result = append(result, handle)
		}
	}
	return result
}

func requestIdempotencyKey(request ParseRequest) string {
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
	encoded, _ := canonicalJSON(values)
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func xmlDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(digest[:])
}

// CanonicalDigest returns the contract's lowercase SHA-256 digest over
// canonical JSON. Persistence can use this without reimplementing the hash.
func CanonicalDigest(value any) (string, error) {
	encoded, err := canonicalJSON(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func validateSemanticXML(value string, expected []string) error {
	decoder := xml.NewDecoder(strings.NewReader(value))
	seen := map[string]bool{}
	root := ""
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if root == "" {
			root = start.Name.Local
		}
		for _, attribute := range start.Attr {
			if attribute.Name.Local == "ref" {
				seen[attribute.Value] = true
			}
		}
	}
	if root != "semantic-ui" {
		return errors.New("root element must be semantic-ui")
	}
	for _, evidenceID := range expected {
		if !seen[evidenceID] {
			return fmt.Errorf("evidence id %q does not resolve to an XML ref", evidenceID)
		}
	}
	return nil
}

func decodeStrict(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("more than one JSON document")
		}
		return err
	}
	return nil
}

func canonicalJSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	var builder strings.Builder
	if err := writeCanonicalJSON(&builder, decoded); err != nil {
		return nil, err
	}
	return []byte(builder.String()), nil
}

func writeCanonicalJSON(builder *strings.Builder, value any) error {
	switch typed := value.(type) {
	case nil:
		builder.WriteString("null")
	case bool:
		builder.WriteString(strconv.FormatBool(typed))
	case string:
		builder.Write(canonicalJSONString(typed))
	case json.Number:
		builder.WriteString(typed.String())
	case []any:
		builder.WriteByte('[')
		for index, child := range typed {
			if index > 0 {
				builder.WriteByte(',')
			}
			if err := writeCanonicalJSON(builder, child); err != nil {
				return err
			}
		}
		builder.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		builder.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				builder.WriteByte(',')
			}
			builder.Write(canonicalJSONString(key))
			builder.WriteByte(':')
			if err := writeCanonicalJSON(builder, typed[key]); err != nil {
				return err
			}
		}
		builder.WriteByte('}')
	default:
		return fmt.Errorf("unsupported canonical JSON value %T", value)
	}
	return nil
}

func canonicalJSONString(value string) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return bytes.TrimSpace(buffer.Bytes())
}
