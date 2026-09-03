package manifest

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
	"strings"
	"time"
)

const ActionListSchemaVersion = "action-list/1"

var (
	actionIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,79}$`)
	toolNamePattern         = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	parameterNamePattern    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	digestPattern           = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	sensitiveLiteralPattern = regexp.MustCompile(`(?i)(bearer\s+[a-z0-9._-]+|api[_-]?key|password|secret|token|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:\d[ -]*?){13,19})`)
)

// ActionList is the strict Go representation of documentation/contracts/action-list.schema.json.
// DecodeActionList rejects unknown fields, while Validate enforces cross-object semantic rules.
type ActionList struct {
	SchemaVersion string         `json:"schemaVersion"`
	ListID        string         `json:"listId"`
	Site          ActionListSite `json:"site"`
	Publication   Publication    `json:"publication"`
	Policy        PolicyDecision `json:"policy"`
	States        []ActionState  `json:"states"`
	Actions       []Action       `json:"actions"`
}

type ActionListSite struct {
	Origin        string   `json:"origin"`
	RoutePatterns []string `json:"routePatterns"`
	TopFrameOnly  bool     `json:"topFrameOnly"`
}

type Publication struct {
	Status        string  `json:"status"`
	Revision      int     `json:"revision"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
	SourceMapID   *string `json:"sourceMapId"`
	ContentDigest *string `json:"contentDigest"`
}

type PolicyDecision struct {
	Status      string   `json:"status"`
	Scopes      []string `json:"scopes"`
	Basis       string   `json:"basis"`
	EvidenceURL *string  `json:"evidenceUrl"`
	CheckedAt   string   `json:"checkedAt"`
	ExpiresAt   *string  `json:"expiresAt"`
	ReviewedBy  string   `json:"reviewedBy"`
	Note        string   `json:"note"`
}

type ActionState struct {
	ID          string       `json:"id"`
	Label       string       `json:"label"`
	Description string       `json:"description"`
	Match       ConditionSet `json:"match"`
}

type Action struct {
	ID           string        `json:"id"`
	Version      int           `json:"version"`
	Lifecycle    string        `json:"lifecycle"`
	Tool         ActionTool    `json:"tool"`
	Precondition Precondition  `json:"precondition"`
	Steps        []ActionStep  `json:"steps"`
	Output       ActionOutput  `json:"output"`
	Safety       ActionSafety  `json:"safety"`
	Runtime      ActionRuntime `json:"runtime"`
	Provenance   Provenance    `json:"provenance"`
}

type ActionTool struct {
	Name        string      `json:"name"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	InputSchema InputSchema `json:"inputSchema"`
	Annotations struct {
		ReadOnlyHint         bool `json:"readOnlyHint"`
		UntrustedContentHint bool `json:"untrustedContentHint"`
	} `json:"annotations"`
}

type InputSchema struct {
	Type                 string                   `json:"type"`
	Properties           map[string]InputProperty `json:"properties"`
	Required             []string                 `json:"required"`
	AdditionalProperties bool                     `json:"additionalProperties"`
}

type InputProperty struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Format      string   `json:"format,omitempty"`
	Enum        []any    `json:"enum,omitempty"`
	Minimum     *float64 `json:"minimum,omitempty"`
	Maximum     *float64 `json:"maximum,omitempty"`
	MinLength   *int     `json:"minLength,omitempty"`
	MaxLength   *int     `json:"maxLength,omitempty"`
}

type Precondition struct {
	AllowedStateIDs []string     `json:"allowedStateIds"`
	URLPatterns     []string     `json:"urlPatterns"`
	Checks          ConditionSet `json:"checks"`
}

type ActionStep struct {
	ID        string              `json:"id"`
	Operation string              `json:"op"`
	Target    *ActionLocator      `json:"target,omitempty"`
	Value     *ValueSource        `json:"value,omitempty"`
	Key       string              `json:"key,omitempty"`
	Expect    ConditionSet        `json:"expect"`
	TimeoutMS int                 `json:"timeoutMs"`
	Evidence  []EvidenceReference `json:"evidence"`
}

type ValueSource struct {
	FromArgument string `json:"fromArgument,omitempty"`
	Literal      any    `json:"literal,omitempty"`
}

func (source ValueSource) MarshalJSON() ([]byte, error) {
	if source.FromArgument != "" {
		return json.Marshal(struct {
			FromArgument string `json:"fromArgument"`
		}{source.FromArgument})
	}
	return json.Marshal(struct {
		Literal any `json:"literal"`
	}{source.Literal})
}

func (source *ValueSource) UnmarshalJSON(data []byte) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return err
	}
	if len(object) != 1 {
		return errors.New("value source must contain exactly one of fromArgument or literal")
	}
	if raw, exists := object["fromArgument"]; exists {
		return json.Unmarshal(raw, &source.FromArgument)
	}
	raw, exists := object["literal"]
	if !exists {
		return errors.New("value source contains an unknown field")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(&source.Literal)
}

type ActionLocator struct {
	Cardinality string            `json:"cardinality"`
	Visible     bool              `json:"visible"`
	Enabled     bool              `json:"enabled"`
	Strategies  []LocatorStrategy `json:"strategies"`
}

type LocatorStrategy struct {
	Kind      string `json:"kind"`
	Selector  string `json:"selector,omitempty"`
	Role      string `json:"role,omitempty"`
	Name      string `json:"name,omitempty"`
	Exact     *bool  `json:"exact,omitempty"`
	Text      string `json:"text,omitempty"`
	Attribute string `json:"attribute,omitempty"`
	Value     string `json:"value,omitempty"`
	Contains  string `json:"contains,omitempty"`
}

type ConditionSet struct {
	Mode   string      `json:"mode"`
	Checks []Condition `json:"checks"`
}

type Condition struct {
	Kind           string         `json:"kind"`
	Pattern        string         `json:"pattern,omitempty"`
	Target         *ActionLocator `json:"target,omitempty"`
	Assertion      string         `json:"assertion,omitempty"`
	MinimumItems   *int           `json:"minimumItems,omitempty"`
	StateID        string         `json:"stateId,omitempty"`
	QuietMS        *int           `json:"quietMs,omitempty"`
	Value          *ValueSource   `json:"value,omitempty"`
	MinimumAdded   *int           `json:"minimumAdded,omitempty"`
	MinimumRemoved *int           `json:"minimumRemoved,omitempty"`
	MinimumChanged *int           `json:"minimumChanged,omitempty"`
}

type ActionOutput struct {
	Mode           string              `json:"mode"`
	CollectionRoot *ActionLocator      `json:"collectionRoot,omitempty"`
	Item           *ActionLocator      `json:"item,omitempty"`
	Limit          int                 `json:"limit,omitempty"`
	Fields         []ActionOutputField `json:"fields,omitempty"`
}

type ActionOutputField struct {
	Name      string        `json:"name"`
	Type      string        `json:"type"`
	Locator   ActionLocator `json:"locator"`
	Read      string        `json:"read"`
	Required  bool          `json:"required"`
	Untrusted bool          `json:"untrusted"`
}

type ActionSafety struct {
	Class               string   `json:"class"`
	WritesExternalState bool     `json:"writesExternalState"`
	Confirmation        string   `json:"confirmation"`
	ConfirmationStepID  *string  `json:"confirmationStepId"`
	Idempotency         string   `json:"idempotency"`
	SensitiveArguments  []string `json:"sensitiveArguments"`
}

type ActionRuntime struct {
	ExecutionSurface  string   `json:"executionSurface"`
	AllowedOrigins    []string `json:"allowedOrigins"`
	MaxDurationMS     int      `json:"maxDurationMs"`
	MaxNavigations    int      `json:"maxNavigations"`
	CloseExecutionTab bool     `json:"closeExecutionTab"`
}

type Provenance struct {
	Source           string   `json:"source"`
	ObservationCount int      `json:"observationCount"`
	TraceIDs         []string `json:"traceIds"`
	Compiler         string   `json:"compiler"`
	CompiledAt       string   `json:"compiledAt"`
	ReviewedAt       *string  `json:"reviewedAt"`
	ReviewedBy       *string  `json:"reviewedBy"`
}

type EvidenceReference struct {
	TraceID             string `json:"traceId"`
	TransitionID        string `json:"transitionId"`
	FromPageID          string `json:"fromPageId"`
	ActionFrameSequence int    `json:"actionFrameSequence"`
	UpdateFrameSequence int    `json:"updateFrameSequence"`
	ToPageID            string `json:"toPageId"`
}

func DecodeActionList(raw json.RawMessage) (ActionList, error) {
	if err := validateActionListShape(raw); err != nil {
		return ActionList{}, err
	}
	var list ActionList
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(&list); err != nil {
		return ActionList{}, fmt.Errorf("decode action list: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ActionList{}, errors.New("action list must contain one JSON object")
	}
	if err := list.Validate(); err != nil {
		return ActionList{}, err
	}
	return list, nil
}

func validateActionListShape(raw json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil {
		return fmt.Errorf("decode action list shape: %w", err)
	}
	if err := requireOnly(root, "$", []string{
		"schemaVersion", "listId", "site", "publication", "policy", "states", "actions",
	}, nil); err != nil {
		return err
	}
	site, err := objectAt(root, "site", "$.site")
	if err != nil {
		return err
	}
	if err := requireOnly(site, "$.site", []string{"origin", "routePatterns", "topFrameOnly"}, nil); err != nil {
		return err
	}
	publication, err := objectAt(root, "publication", "$.publication")
	if err != nil {
		return err
	}
	if err := requireOnly(publication, "$.publication", []string{
		"status", "revision", "createdAt", "updatedAt", "sourceMapId", "contentDigest",
	}, nil); err != nil {
		return err
	}
	policy, err := objectAt(root, "policy", "$.policy")
	if err != nil {
		return err
	}
	if err := requireOnly(policy, "$.policy", []string{
		"status", "scopes", "basis", "evidenceUrl", "checkedAt", "expiresAt", "reviewedBy", "note",
	}, nil); err != nil {
		return err
	}
	states, err := arrayAt(root, "states", "$.states")
	if err != nil {
		return err
	}
	for index, item := range states {
		path := fmt.Sprintf("$.states[%d]", index)
		state, err := asObject(item, path)
		if err != nil {
			return err
		}
		if err := requireOnly(state, path, []string{"id", "label", "description", "match"}, nil); err != nil {
			return err
		}
		if err := validateConditionSetShape(state["match"], path+".match"); err != nil {
			return err
		}
	}
	actions, err := arrayAt(root, "actions", "$.actions")
	if err != nil {
		return err
	}
	for index, item := range actions {
		if err := validateActionShape(item, fmt.Sprintf("$.actions[%d]", index)); err != nil {
			return err
		}
	}
	return nil
}

func validateActionShape(value any, path string) error {
	action, err := asObject(value, path)
	if err != nil {
		return err
	}
	if err := requireOnly(action, path, []string{
		"id", "version", "lifecycle", "tool", "precondition", "steps", "output", "safety", "runtime", "provenance",
	}, nil); err != nil {
		return err
	}
	tool, err := objectAt(action, "tool", path+".tool")
	if err != nil {
		return err
	}
	if err := requireOnly(tool, path+".tool", []string{"name", "title", "description", "inputSchema", "annotations"}, nil); err != nil {
		return err
	}
	input, err := objectAt(tool, "inputSchema", path+".tool.inputSchema")
	if err != nil {
		return err
	}
	if err := requireOnly(input, path+".tool.inputSchema", []string{"type", "properties", "required", "additionalProperties"}, nil); err != nil {
		return err
	}
	properties, err := objectAt(input, "properties", path+".tool.inputSchema.properties")
	if err != nil {
		return err
	}
	for name, value := range properties {
		propertyPath := path + ".tool.inputSchema.properties." + name
		property, err := asObject(value, propertyPath)
		if err != nil {
			return err
		}
		if err := requireOnly(property, propertyPath, []string{"type", "description"}, []string{
			"format", "enum", "minimum", "maximum", "minLength", "maxLength",
		}); err != nil {
			return err
		}
	}
	annotations, err := objectAt(tool, "annotations", path+".tool.annotations")
	if err != nil {
		return err
	}
	if err := requireOnly(annotations, path+".tool.annotations", []string{"readOnlyHint", "untrustedContentHint"}, nil); err != nil {
		return err
	}
	precondition, err := objectAt(action, "precondition", path+".precondition")
	if err != nil {
		return err
	}
	if err := requireOnly(precondition, path+".precondition", []string{"allowedStateIds", "urlPatterns", "checks"}, nil); err != nil {
		return err
	}
	if err := validateConditionSetShape(precondition["checks"], path+".precondition.checks"); err != nil {
		return err
	}
	steps, err := arrayAt(action, "steps", path+".steps")
	if err != nil {
		return err
	}
	for index, item := range steps {
		if err := validateStepShape(item, fmt.Sprintf("%s.steps[%d]", path, index)); err != nil {
			return err
		}
	}
	if err := validateOutputShape(action["output"], path+".output"); err != nil {
		return err
	}
	safety, err := objectAt(action, "safety", path+".safety")
	if err != nil {
		return err
	}
	if err := requireOnly(safety, path+".safety", []string{
		"class", "writesExternalState", "confirmation", "confirmationStepId", "idempotency", "sensitiveArguments",
	}, nil); err != nil {
		return err
	}
	runtime, err := objectAt(action, "runtime", path+".runtime")
	if err != nil {
		return err
	}
	if err := requireOnly(runtime, path+".runtime", []string{
		"executionSurface", "allowedOrigins", "maxDurationMs", "maxNavigations", "closeExecutionTab",
	}, nil); err != nil {
		return err
	}
	provenance, err := objectAt(action, "provenance", path+".provenance")
	if err != nil {
		return err
	}
	return requireOnly(provenance, path+".provenance", []string{
		"source", "observationCount", "traceIds", "compiler", "compiledAt", "reviewedAt", "reviewedBy",
	}, nil)
}

func validateStepShape(value any, path string) error {
	step, err := asObject(value, path)
	if err != nil {
		return err
	}
	operation, _ := step["op"].(string)
	required := []string{"id", "op", "expect", "timeoutMs", "evidence"}
	allowed := []string{}
	switch operation {
	case "fill":
		required = append(required, "target", "value")
	case "click":
		required = append(required, "target")
	case "press":
		required = append(required, "target", "key")
	case "wait", "extract":
	default:
		return fmt.Errorf("%s.op is invalid", path)
	}
	if err := requireOnly(step, path, required, allowed); err != nil {
		return err
	}
	if target, exists := step["target"]; exists {
		if err := validateLocatorShape(target, path+".target"); err != nil {
			return err
		}
	}
	if value, exists := step["value"]; exists {
		if err := validateValueSourceShape(value, path+".value"); err != nil {
			return err
		}
	}
	if err := validateConditionSetShape(step["expect"], path+".expect"); err != nil {
		return err
	}
	evidence, err := arrayAt(step, "evidence", path+".evidence")
	if err != nil {
		return err
	}
	for index, item := range evidence {
		evidencePath := fmt.Sprintf("%s.evidence[%d]", path, index)
		object, err := asObject(item, evidencePath)
		if err != nil {
			return err
		}
		if err := requireOnly(object, evidencePath, []string{
			"traceId", "transitionId", "fromPageId", "actionFrameSequence", "updateFrameSequence", "toPageId",
		}, nil); err != nil {
			return err
		}
	}
	return nil
}

func validateLocatorShape(value any, path string) error {
	locator, err := asObject(value, path)
	if err != nil {
		return err
	}
	if err := requireOnly(locator, path, []string{"cardinality", "visible", "enabled", "strategies"}, nil); err != nil {
		return err
	}
	strategies, err := arrayAt(locator, "strategies", path+".strategies")
	if err != nil {
		return err
	}
	for index, item := range strategies {
		strategyPath := fmt.Sprintf("%s.strategies[%d]", path, index)
		strategy, err := asObject(item, strategyPath)
		if err != nil {
			return err
		}
		kind, _ := strategy["kind"].(string)
		var required []string
		switch kind {
		case "css":
			required = []string{"kind", "selector"}
		case "role":
			required = []string{"kind", "role", "name", "exact"}
		case "label", "placeholder", "text":
			required = []string{"kind", "text", "exact"}
		case "attribute":
			required = []string{"kind", "attribute", "value"}
		case "href":
			required = []string{"kind", "contains"}
		case "active_element":
			required = []string{"kind"}
		default:
			return fmt.Errorf("%s.kind is invalid", strategyPath)
		}
		if err := requireOnly(strategy, strategyPath, required, nil); err != nil {
			return err
		}
	}
	return nil
}

func validateConditionSetShape(value any, path string) error {
	set, err := asObject(value, path)
	if err != nil {
		return err
	}
	if err := requireOnly(set, path, []string{"mode", "checks"}, nil); err != nil {
		return err
	}
	checks, err := arrayAt(set, "checks", path+".checks")
	if err != nil {
		return err
	}
	for index, item := range checks {
		checkPath := fmt.Sprintf("%s.checks[%d]", path, index)
		check, err := asObject(item, checkPath)
		if err != nil {
			return err
		}
		kind, _ := check["kind"].(string)
		var required []string
		switch kind {
		case "url":
			required = []string{"kind", "pattern"}
		case "element":
			required = []string{"kind", "target", "assertion"}
		case "collection":
			required = []string{"kind", "target", "minimumItems"}
		case "state":
			required = []string{"kind", "stateId"}
		case "dom_stable":
			required = []string{"kind", "quietMs"}
		case "target_value":
			required = []string{"kind", "value"}
		case "dom_change":
			required = []string{"kind", "minimumAdded", "minimumRemoved", "minimumChanged"}
		default:
			return fmt.Errorf("%s.kind is invalid", checkPath)
		}
		if err := requireOnly(check, checkPath, required, nil); err != nil {
			return err
		}
		if target, exists := check["target"]; exists {
			if err := validateLocatorShape(target, checkPath+".target"); err != nil {
				return err
			}
		}
		if source, exists := check["value"]; exists {
			if err := validateValueSourceShape(source, checkPath+".value"); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateValueSourceShape(value any, path string) error {
	source, err := asObject(value, path)
	if err != nil {
		return err
	}
	if len(source) != 1 {
		return fmt.Errorf("%s must contain exactly one value source", path)
	}
	if _, exists := source["fromArgument"]; exists {
		return nil
	}
	if _, exists := source["literal"]; exists {
		return nil
	}
	return fmt.Errorf("%s contains an unknown value source", path)
}

func validateOutputShape(value any, path string) error {
	output, err := asObject(value, path)
	if err != nil {
		return err
	}
	mode, _ := output["mode"].(string)
	var required []string
	switch mode {
	case "none":
		required = []string{"mode"}
	case "page":
		required = []string{"mode", "fields"}
	case "collection":
		required = []string{"mode", "collectionRoot", "item", "limit", "fields"}
	default:
		return fmt.Errorf("%s.mode is invalid", path)
	}
	if err := requireOnly(output, path, required, nil); err != nil {
		return err
	}
	if root, exists := output["collectionRoot"]; exists {
		if err := validateLocatorShape(root, path+".collectionRoot"); err != nil {
			return err
		}
	}
	if item, exists := output["item"]; exists {
		if err := validateLocatorShape(item, path+".item"); err != nil {
			return err
		}
	}
	if fieldsValue, exists := output["fields"]; exists {
		fields, ok := fieldsValue.([]any)
		if !ok {
			return fmt.Errorf("%s.fields must be an array", path)
		}
		for index, item := range fields {
			fieldPath := fmt.Sprintf("%s.fields[%d]", path, index)
			field, err := asObject(item, fieldPath)
			if err != nil {
				return err
			}
			if err := requireOnly(field, fieldPath, []string{"name", "type", "locator", "read", "required", "untrusted"}, nil); err != nil {
				return err
			}
			if err := validateLocatorShape(field["locator"], fieldPath+".locator"); err != nil {
				return err
			}
		}
	}
	return nil
}

func requireOnly(object map[string]any, path string, required, optional []string) error {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
		if _, exists := object[key]; !exists {
			return fmt.Errorf("%s.%s is required", path, key)
		}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	for key := range object {
		if _, exists := allowed[key]; !exists {
			return fmt.Errorf("%s contains unknown field %q", path, key)
		}
	}
	return nil
}

func objectAt(object map[string]any, key, path string) (map[string]any, error) {
	return asObject(object[key], path)
}

func asObject(value any, path string) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", path)
	}
	return object, nil
}

func arrayAt(object map[string]any, key, path string) ([]any, error) {
	values, ok := object[key].([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", path)
	}
	return values, nil
}

func (list ActionList) Validate() error {
	problems := make([]string, 0)
	if list.SchemaVersion != ActionListSchemaVersion {
		problems = append(problems, "schemaVersion must be "+ActionListSchemaVersion)
	}
	if !actionIdentifierPattern.MatchString(list.ListID) {
		problems = append(problems, "listId is invalid")
	}
	if err := validateOrigin(list.Site.Origin); err != nil {
		problems = append(problems, "site.origin must be an exact HTTP or HTTPS origin")
	}
	if len(list.Site.RoutePatterns) < 1 || len(list.Site.RoutePatterns) > 32 {
		problems = append(problems, "site.routePatterns must contain between 1 and 32 patterns")
	}
	if !uniqueStrings(list.Site.RoutePatterns) {
		problems = append(problems, "site.routePatterns must be unique")
	}
	for _, pattern := range list.Site.RoutePatterns {
		if err := validateRegex(pattern); err != nil {
			problems = append(problems, "invalid site route pattern: "+err.Error())
		}
	}
	if !contains([]string{"draft", "candidate", "published", "degraded", "quarantined"}, list.Publication.Status) {
		problems = append(problems, "publication.status is invalid")
	}
	if list.Publication.Revision < 1 {
		problems = append(problems, "publication.revision must be at least 1")
	}
	if !validTimestamp(list.Publication.CreatedAt) || !validTimestamp(list.Publication.UpdatedAt) {
		problems = append(problems, "publication timestamps must be RFC3339 timestamps")
	}
	if list.Publication.Status == "published" {
		if list.Publication.ContentDigest == nil || !digestPattern.MatchString(*list.Publication.ContentDigest) {
			problems = append(problems, "published list requires a valid contentDigest")
		}
	} else if list.Publication.ContentDigest != nil {
		problems = append(problems, "unpublished list contentDigest must be null")
	}
	problems = append(problems, list.Policy.validate()...)
	if len(list.States) < 1 || len(list.States) > 64 {
		problems = append(problems, "states must contain between 1 and 64 entries")
	}
	if len(list.Actions) < 1 || len(list.Actions) > 128 {
		problems = append(problems, "actions must contain between 1 and 128 entries")
	}

	stateIDs := make(map[string]struct{}, len(list.States))
	for index, state := range list.States {
		path := fmt.Sprintf("states[%d]", index)
		if !addUnique(stateIDs, state.ID) || !actionIdentifierPattern.MatchString(state.ID) {
			problems = append(problems, path+".id must be unique and valid")
		}
		if blank(state.Label) || blank(state.Description) {
			problems = append(problems, path+" label and description are required")
		}
		problems = append(problems, validateConditionSet(path+".match", state.Match, nil)...)
	}
	for index, state := range list.States {
		problems = append(problems, validateConditionStateReferences(
			fmt.Sprintf("states[%d].match", index), state.Match, stateIDs,
		)...)
	}
	actionIDs := make(map[string]struct{}, len(list.Actions))
	toolNames := make(map[string]struct{}, len(list.Actions))
	for index := range list.Actions {
		problems = append(problems, validateAction(&list, index, stateIDs, actionIDs, toolNames)...)
	}
	if list.Publication.Status == "published" {
		if list.Policy.Status != "allowed" {
			problems = append(problems, "published list requires an allowed policy")
		}
		for _, action := range list.Actions {
			if action.Lifecycle != "published" {
				problems = append(problems, "published list may contain only published actions")
			}
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func validateAction(
	list *ActionList,
	index int,
	stateIDs map[string]struct{},
	actionIDs map[string]struct{},
	toolNames map[string]struct{},
) []string {
	action := &list.Actions[index]
	path := fmt.Sprintf("actions[%d]", index)
	problems := make([]string, 0)
	if !actionIdentifierPattern.MatchString(action.ID) || !addUnique(actionIDs, action.ID) {
		problems = append(problems, path+".id must be unique and valid")
	}
	if action.Version < 1 {
		problems = append(problems, path+".version must be at least 1")
	}
	if !contains([]string{"candidate", "published", "degraded", "quarantined"}, action.Lifecycle) {
		problems = append(problems, path+".lifecycle is invalid")
	}
	if !toolNamePattern.MatchString(action.Tool.Name) || !addUnique(toolNames, action.Tool.Name) {
		problems = append(problems, path+".tool.name must be unique and valid")
	}
	if blank(action.Tool.Title) || blank(action.Tool.Description) {
		problems = append(problems, path+".tool title and description are required")
	}
	if action.Tool.InputSchema.Type != "object" || action.Tool.InputSchema.AdditionalProperties {
		problems = append(problems, path+".tool.inputSchema must be a closed object schema")
	}
	for name, property := range action.Tool.InputSchema.Properties {
		if !parameterNamePattern.MatchString(name) || blank(property.Description) ||
			!contains([]string{"string", "number", "integer", "boolean"}, property.Type) {
			problems = append(problems, path+".tool.inputSchema has an invalid property "+name)
		}
		if len(property.Description) > 2000 || property.Enum != nil && (len(property.Enum) < 1 || len(property.Enum) > 100) ||
			property.MinLength != nil && *property.MinLength < 0 ||
			property.MaxLength != nil && (*property.MaxLength < 1 || *property.MaxLength > 10000) ||
			property.MinLength != nil && property.MaxLength != nil && *property.MinLength > *property.MaxLength ||
			property.Minimum != nil && property.Maximum != nil && *property.Minimum > *property.Maximum {
			problems = append(problems, path+".tool.inputSchema property constraints are invalid for "+name)
		}
	}
	required := make(map[string]struct{}, len(action.Tool.InputSchema.Required))
	for _, name := range action.Tool.InputSchema.Required {
		if _, exists := action.Tool.InputSchema.Properties[name]; !exists || !addUnique(required, name) {
			problems = append(problems, path+".tool.inputSchema.required references an unknown or duplicate property")
		}
	}
	for _, stateID := range action.Precondition.AllowedStateIDs {
		if _, exists := stateIDs[stateID]; !exists {
			problems = append(problems, path+".precondition references unknown state "+stateID)
		}
	}
	if len(action.Precondition.AllowedStateIDs) < 1 || len(action.Precondition.URLPatterns) < 1 {
		problems = append(problems, path+".precondition must declare states and URL patterns")
	}
	if len(action.Precondition.AllowedStateIDs) > 16 || len(action.Precondition.URLPatterns) > 16 ||
		!uniqueStrings(action.Precondition.AllowedStateIDs) || !uniqueStrings(action.Precondition.URLPatterns) {
		problems = append(problems, path+".precondition state and URL lists must be bounded and unique")
	}
	for _, pattern := range action.Precondition.URLPatterns {
		if err := validateRegex(pattern); err != nil {
			problems = append(problems, path+".precondition has invalid URL pattern")
		}
	}
	problems = append(problems, validateConditionSet(path+".precondition.checks", action.Precondition.Checks, stateIDs)...)
	problems = append(problems, validateConditionArguments(path+".precondition.checks", action.Precondition.Checks, action.Tool.InputSchema.Properties)...)
	if len(action.Steps) < 1 || len(action.Steps) > 32 {
		problems = append(problems, path+".steps must contain between 1 and 32 steps")
	}
	stepIDs := make(map[string]struct{}, len(action.Steps))
	extractCount := 0
	for stepIndex, step := range action.Steps {
		stepPath := fmt.Sprintf("%s.steps[%d]", path, stepIndex)
		if !actionIdentifierPattern.MatchString(step.ID) || !addUnique(stepIDs, step.ID) {
			problems = append(problems, stepPath+".id must be unique and valid")
		}
		if !contains([]string{"fill", "click", "press", "wait", "extract"}, step.Operation) {
			problems = append(problems, stepPath+".op is invalid")
		}
		if (step.Operation == "fill" || step.Operation == "click" || step.Operation == "press") && step.Target == nil {
			problems = append(problems, stepPath+" requires a target")
		}
		if step.Target != nil {
			problems = append(problems, validateLocator(stepPath+".target", *step.Target)...)
		}
		if step.Operation == "fill" {
			if step.Value == nil {
				problems = append(problems, stepPath+" requires a value")
			} else {
				problems = append(problems, validateValueSource(stepPath+".value", *step.Value, action.Tool.InputSchema.Properties)...)
			}
		}
		if step.Operation == "press" && !contains([]string{"Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Tab", "Space"}, step.Key) {
			problems = append(problems, stepPath+".key is invalid")
		}
		if step.TimeoutMS < 100 || step.TimeoutMS > 60000 {
			problems = append(problems, stepPath+".timeoutMs is outside 100..60000")
		}
		problems = append(problems, validateConditionSet(stepPath+".expect", step.Expect, stateIDs)...)
		problems = append(problems, validateConditionArguments(stepPath+".expect", step.Expect, action.Tool.InputSchema.Properties)...)
		if len(step.Evidence) < 1 || len(step.Evidence) > 16 {
			problems = append(problems, stepPath+".evidence must contain between 1 and 16 entries")
		}
		for _, evidence := range step.Evidence {
			if evidence.ActionFrameSequence < 1 || evidence.UpdateFrameSequence <= evidence.ActionFrameSequence ||
				!actionIdentifierPattern.MatchString(evidence.TraceID) || !actionIdentifierPattern.MatchString(evidence.TransitionID) ||
				!actionIdentifierPattern.MatchString(evidence.FromPageID) || !actionIdentifierPattern.MatchString(evidence.ToPageID) {
				problems = append(problems, stepPath+" has invalid evidence chronology or identifiers")
			}
		}
		if step.Operation == "extract" {
			extractCount++
		}
	}
	problems = append(problems, validateOutput(path+".output", action.Output)...)
	if action.Output.Mode == "none" && extractCount != 0 || action.Output.Mode != "none" && (extractCount != 1 || action.Steps[len(action.Steps)-1].Operation != "extract") {
		problems = append(problems, path+" extract step must agree with output mode and be final")
	}
	problems = append(problems, validateSafety(path+".safety", action, stepIDs)...)
	if action.Tool.Annotations.ReadOnlyHint != !action.Safety.WritesExternalState {
		problems = append(problems, path+" readOnlyHint must be the inverse of writesExternalState")
	}
	if !contains(action.Runtime.AllowedOrigins, list.Site.Origin) {
		problems = append(problems, path+".runtime.allowedOrigins must include the site origin")
	}
	if len(action.Runtime.AllowedOrigins) < 1 || len(action.Runtime.AllowedOrigins) > 8 || !uniqueStrings(action.Runtime.AllowedOrigins) {
		problems = append(problems, path+".runtime.allowedOrigins must be bounded and unique")
	}
	for _, origin := range action.Runtime.AllowedOrigins {
		if validateOrigin(origin) != nil {
			problems = append(problems, path+".runtime.allowedOrigins contains an invalid origin")
		}
	}
	if !contains([]string{"inactive_tab", "current_tab"}, action.Runtime.ExecutionSurface) ||
		action.Runtime.MaxDurationMS < 1000 || action.Runtime.MaxDurationMS > 300000 ||
		action.Runtime.MaxNavigations < 0 || action.Runtime.MaxNavigations > 20 {
		problems = append(problems, path+".runtime is invalid")
	}
	if !contains([]string{"demonstration", "manual", "imported"}, action.Provenance.Source) ||
		action.Provenance.ObservationCount < 1 || len(action.Provenance.TraceIDs) < 1 || blank(action.Provenance.Compiler) ||
		!validTimestamp(action.Provenance.CompiledAt) {
		problems = append(problems, path+".provenance is invalid")
	}
	if len(action.Provenance.TraceIDs) > 100 || !uniqueStrings(action.Provenance.TraceIDs) {
		problems = append(problems, path+".provenance.traceIds must be bounded and unique")
	}
	for _, traceID := range action.Provenance.TraceIDs {
		if !actionIdentifierPattern.MatchString(traceID) {
			problems = append(problems, path+".provenance contains an invalid traceId")
		}
	}
	return problems
}

func validateConditionSet(path string, set ConditionSet, states map[string]struct{}) []string {
	problems := make([]string, 0)
	if !contains([]string{"all", "any"}, set.Mode) || len(set.Checks) < 1 || len(set.Checks) > 16 {
		return append(problems, path+" must contain 1..16 checks in all or any mode")
	}
	for index, check := range set.Checks {
		checkPath := fmt.Sprintf("%s.checks[%d]", path, index)
		switch check.Kind {
		case "url":
			if validateRegex(check.Pattern) != nil {
				problems = append(problems, checkPath+" has an invalid URL pattern")
			}
		case "element":
			if check.Target == nil || !contains([]string{"present", "absent", "visible", "hidden", "enabled", "disabled"}, check.Assertion) {
				problems = append(problems, checkPath+" is an invalid element condition")
			} else {
				problems = append(problems, validateLocator(checkPath+".target", *check.Target)...)
			}
		case "collection":
			if check.Target == nil || check.MinimumItems == nil || *check.MinimumItems < 0 || *check.MinimumItems > 10000 {
				problems = append(problems, checkPath+" is an invalid collection condition")
			} else {
				problems = append(problems, validateLocator(checkPath+".target", *check.Target)...)
			}
		case "state":
			if states != nil {
				if _, exists := states[check.StateID]; !exists {
					problems = append(problems, checkPath+" references unknown state "+check.StateID)
				}
			}
		case "dom_stable":
			if check.QuietMS == nil || *check.QuietMS < 50 || *check.QuietMS > 5000 {
				problems = append(problems, checkPath+" has invalid quietMs")
			}
		case "target_value":
			if check.Value == nil {
				problems = append(problems, checkPath+" requires a value")
			}
		case "dom_change":
			if check.MinimumAdded == nil || check.MinimumRemoved == nil || check.MinimumChanged == nil ||
				*check.MinimumAdded < 0 || *check.MinimumRemoved < 0 || *check.MinimumChanged < 0 {
				problems = append(problems, checkPath+" has invalid change counts")
			}
		default:
			problems = append(problems, checkPath+".kind is invalid")
		}
	}
	return problems
}

func validateConditionStateReferences(path string, set ConditionSet, states map[string]struct{}) []string {
	problems := make([]string, 0)
	for index, check := range set.Checks {
		if check.Kind != "state" {
			continue
		}
		if _, exists := states[check.StateID]; !exists {
			problems = append(problems, fmt.Sprintf("%s.checks[%d] references unknown state %s", path, index, check.StateID))
		}
	}
	return problems
}

func validateConditionArguments(path string, set ConditionSet, properties map[string]InputProperty) []string {
	problems := make([]string, 0)
	for index, check := range set.Checks {
		if check.Kind != "target_value" || check.Value == nil {
			continue
		}
		problems = append(problems, validateValueSource(
			fmt.Sprintf("%s.checks[%d].value", path, index), *check.Value, properties,
		)...)
	}
	return problems
}

func validateLocator(path string, locator ActionLocator) []string {
	problems := make([]string, 0)
	if !contains([]string{"one", "zero_or_one", "many"}, locator.Cardinality) || len(locator.Strategies) < 1 || len(locator.Strategies) > 8 {
		return append(problems, path+" is invalid")
	}
	for index, strategy := range locator.Strategies {
		strategyPath := fmt.Sprintf("%s.strategies[%d]", path, index)
		switch strategy.Kind {
		case "css":
			if blank(strategy.Selector) || len(strategy.Selector) > 2000 || strings.Contains(strategy.Selector, ":nth-child(") || strings.Contains(strategy.Selector, ":nth-of-type(") {
				problems = append(problems, strategyPath+" has an invalid or generated CSS selector")
			}
		case "role":
			if blank(strategy.Role) || blank(strategy.Name) || strategy.Exact == nil {
				problems = append(problems, strategyPath+" is an invalid role strategy")
			}
		case "label", "placeholder", "text":
			if blank(strategy.Text) || strategy.Exact == nil {
				problems = append(problems, strategyPath+" is an invalid text strategy")
			}
		case "attribute":
			if !contains([]string{"id", "name", "data-testid", "data-test", "data-qa", "aria-label"}, strategy.Attribute) || blank(strategy.Value) {
				problems = append(problems, strategyPath+" is an invalid attribute strategy")
			}
		case "href":
			if blank(strategy.Contains) {
				problems = append(problems, strategyPath+" is an invalid href strategy")
			}
		case "active_element":
		default:
			problems = append(problems, strategyPath+".kind is invalid")
		}
	}
	return problems
}

func validateValueSource(path string, source ValueSource, properties map[string]InputProperty) []string {
	if source.FromArgument != "" {
		if _, exists := properties[source.FromArgument]; !exists {
			return []string{path + " references an unknown argument"}
		}
		return nil
	}
	if literal, ok := source.Literal.(string); ok && sensitiveLiteralPattern.MatchString(literal) {
		return []string{path + " contains a privacy-sensitive literal"}
	}
	return nil
}

func validateOutput(path string, output ActionOutput) []string {
	problems := make([]string, 0)
	switch output.Mode {
	case "none":
		if output.CollectionRoot != nil || output.Item != nil || output.Limit != 0 || len(output.Fields) != 0 {
			problems = append(problems, path+" none output contains extra fields")
		}
	case "page":
		if len(output.Fields) < 1 || len(output.Fields) > 32 || output.CollectionRoot != nil || output.Item != nil || output.Limit != 0 {
			problems = append(problems, path+" page output is invalid")
		}
	case "collection":
		if output.CollectionRoot == nil || output.Item == nil || output.Limit < 1 || output.Limit > 100 || len(output.Fields) < 1 || len(output.Fields) > 32 {
			problems = append(problems, path+" collection output is invalid")
		} else {
			problems = append(problems, validateLocator(path+".collectionRoot", *output.CollectionRoot)...)
			problems = append(problems, validateLocator(path+".item", *output.Item)...)
		}
	default:
		problems = append(problems, path+".mode is invalid")
	}
	fieldNames := make(map[string]struct{}, len(output.Fields))
	for index, field := range output.Fields {
		fieldPath := fmt.Sprintf("%s.fields[%d]", path, index)
		if !parameterNamePattern.MatchString(field.Name) || !addUnique(fieldNames, field.Name) ||
			!contains([]string{"string", "number", "integer", "boolean", "url"}, field.Type) ||
			!contains([]string{"text", "value", "href", "src", "checked", "selected"}, field.Read) {
			problems = append(problems, fieldPath+" is invalid")
		}
		problems = append(problems, validateLocator(fieldPath+".locator", field.Locator)...)
	}
	return problems
}

func validateSafety(path string, action *Action, stepIDs map[string]struct{}) []string {
	problems := make([]string, 0)
	if !contains([]string{"read", "write", "danger"}, action.Safety.Class) ||
		!contains([]string{"never", "before_run", "before_step"}, action.Safety.Confirmation) ||
		!contains([]string{"safe", "conditional", "unsafe"}, action.Safety.Idempotency) {
		problems = append(problems, path+" is invalid")
	}
	if action.Safety.Class == "read" && (action.Safety.WritesExternalState || action.Safety.Confirmation != "never" || action.Safety.ConfirmationStepID != nil) {
		problems = append(problems, path+" read actions must be non-writing and require no confirmation")
	}
	if action.Safety.Confirmation == "before_step" {
		if action.Safety.ConfirmationStepID == nil {
			problems = append(problems, path+" requires confirmationStepId")
		} else if _, exists := stepIDs[*action.Safety.ConfirmationStepID]; !exists {
			problems = append(problems, path+" references an unknown confirmation step")
		}
	} else if action.Safety.ConfirmationStepID != nil {
		problems = append(problems, path+" confirmationStepId must be null")
	}
	seen := make(map[string]struct{}, len(action.Safety.SensitiveArguments))
	for _, name := range action.Safety.SensitiveArguments {
		if _, exists := action.Tool.InputSchema.Properties[name]; !exists || !addUnique(seen, name) {
			problems = append(problems, path+" references an unknown or duplicate sensitive argument")
		}
	}
	return problems
}

func (policy PolicyDecision) validate() []string {
	problems := make([]string, 0)
	if !contains([]string{"allowed", "denied", "unknown"}, policy.Status) ||
		!contains([]string{"site_owner", "written_permission", "reviewed_terms", "local_fixture", "unreviewed"}, policy.Basis) ||
		blank(policy.ReviewedBy) || !validTimestamp(policy.CheckedAt) {
		problems = append(problems, "policy is invalid")
	}
	seen := make(map[string]struct{}, len(policy.Scopes))
	for _, scope := range policy.Scopes {
		if !contains([]string{"learn", "inject", "read", "write", "danger"}, scope) || !addUnique(seen, scope) {
			problems = append(problems, "policy contains an invalid or duplicate scope")
		}
	}
	if policy.ExpiresAt != nil && !validTimestamp(*policy.ExpiresAt) {
		problems = append(problems, "policy.expiresAt is invalid")
	}
	if policy.EvidenceURL != nil {
		parsed, err := url.Parse(*policy.EvidenceURL)
		if err != nil || parsed.Scheme == "" {
			problems = append(problems, "policy.evidenceUrl is invalid")
		}
	}
	return problems
}

func CandidateDigest(raw json.RawMessage) (string, error) {
	if _, err := DecodeActionList(raw); err != nil {
		return "", err
	}
	return canonicalDigest(raw)
}

func PublishActionList(raw json.RawMessage, publishedAt time.Time) (json.RawMessage, string, error) {
	list, err := DecodeActionList(raw)
	if err != nil {
		return nil, "", err
	}
	if list.Publication.Status == "published" {
		return nil, "", errors.New("action list revision is already published")
	}
	list.Publication.Status = "published"
	list.Publication.UpdatedAt = publishedAt.UTC().Format(time.RFC3339Nano)
	list.Publication.ContentDigest = nil
	for index := range list.Actions {
		list.Actions[index].Lifecycle = "published"
	}
	pending, err := json.Marshal(list)
	if err != nil {
		return nil, "", fmt.Errorf("encode published action list: %w", err)
	}
	digest, err := canonicalDigest(pending)
	if err != nil {
		return nil, "", err
	}
	list.Publication.ContentDigest = &digest
	published, err := json.Marshal(list)
	if err != nil {
		return nil, "", fmt.Errorf("encode published action list: %w", err)
	}
	if _, err := DecodeActionList(published); err != nil {
		return nil, "", fmt.Errorf("validate published action list: %w", err)
	}
	return published, digest, nil
}

func VerifyDigest(raw json.RawMessage, expected string) error {
	list, err := DecodeActionList(raw)
	if err != nil {
		return err
	}
	if list.Publication.ContentDigest == nil || *list.Publication.ContentDigest != expected {
		return errors.New("stored action list digest does not match its publication metadata")
	}
	actual, err := canonicalDigest(raw)
	if err != nil {
		return err
	}
	if actual != expected {
		return errors.New("stored action list content digest is invalid")
	}
	return nil
}

func MatchesLocation(list ActionList, absoluteURL string) bool {
	parsed, err := url.Parse(absoluteURL)
	if err != nil || parsed.Scheme+"://"+parsed.Host != list.Site.Origin {
		return false
	}
	route := parsed.EscapedPath()
	if route == "" {
		route = "/"
	}
	if parsed.RawQuery != "" {
		route += "?" + parsed.RawQuery
	}
	for _, pattern := range list.Site.RoutePatterns {
		compiled, err := regexp.Compile(pattern)
		if err == nil && compiled.MatchString(route) {
			return true
		}
	}
	return false
}

func policyExpired(policy PolicyDecision, now time.Time) bool {
	if policy.ExpiresAt == nil {
		return false
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, *policy.ExpiresAt)
	return err != nil || !expiresAt.After(now)
}

func PolicyAllows(list ActionList, now time.Time) error {
	if list.Policy.Status != "allowed" || policyExpired(list.Policy, now) {
		return errors.New("policy decision is not currently allowed")
	}
	if !contains(list.Policy.Scopes, "inject") {
		return errors.New("policy decision does not allow injection")
	}
	for _, action := range list.Actions {
		if !contains(list.Policy.Scopes, action.Safety.Class) {
			return fmt.Errorf("policy decision does not allow %s actions", action.Safety.Class)
		}
	}
	return nil
}

func canonicalDigest(raw json.RawMessage) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return "", fmt.Errorf("decode canonical action list: %w", err)
	}
	publication, ok := value["publication"].(map[string]any)
	if !ok {
		return "", errors.New("action list publication is missing")
	}
	delete(publication, "contentDigest")
	canonical, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode canonical action list: %w", err)
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func validateOrigin(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return errors.New("invalid origin")
	}
	return nil
}

func validateRegex(value string) error {
	if value == "" || len(value) > 1000 {
		return errors.New("pattern length is invalid")
	}
	_, err := regexp.Compile(value)
	return err
}

func validTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func addUnique(values map[string]struct{}, value string) bool {
	if _, exists := values[value]; exists {
		return false
	}
	values[value] = struct{}{}
	return true
}

func uniqueStrings(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !addUnique(seen, value) {
			return false
		}
	}
	return true
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func blank(value string) bool {
	return strings.TrimSpace(value) == ""
}
