package learning

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/privacy"
	learningtrace "webmcp-automator/server/internal/trace"
)

const SemanticPromptVersion = "semanticizer/1"

type Diagnostic struct {
	Code    string `json:"code"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

type SemanticInput struct {
	SchemaVersion string                     `json:"schemaVersion"`
	TraceID       string                     `json:"traceId"`
	Origin        string                     `json:"origin"`
	RootPageID    string                     `json:"rootPageId"`
	FinalPageID   string                     `json:"finalPageId"`
	Pages         []learningtrace.Page       `json:"pages"`
	Transitions   []learningtrace.Transition `json:"transitions"`
}

type SemanticResult struct {
	ActionMap      actionmap.Map   `json:"actionMap"`
	Provider       string          `json:"provider"`
	Model          string          `json:"model"`
	PromptVersion  string          `json:"promptVersion"`
	ResponseDigest string          `json:"responseDigest"`
	ResponseID     string          `json:"responseId,omitempty"`
	Finish         string          `json:"finishReason,omitempty"`
	Usage          json.RawMessage `json:"usage,omitempty"`
}

type Semanticizer interface {
	Semanticize(context.Context, SemanticInput) (SemanticResult, error)
}

// MinimizeGraph creates the only representation allowed to cross the model
// boundary. It omits raw markup, geometry, mutation text, and user values.
func MinimizeGraph(graph learningtrace.Graph) SemanticInput {
	input := SemanticInput{
		SchemaVersion: SemanticPromptVersion, TraceID: graph.TraceID,
		Origin: graph.Origin, RootPageID: graph.RootPageID, FinalPageID: graph.FinalPageID,
	}
	for _, page := range graph.Pages {
		copyPage := learningtrace.Page{
			ID: page.ID, Fingerprint: page.Fingerprint, URL: page.URL,
		}
		for _, node := range page.Nodes {
			copyPage.Nodes = append(copyPage.Nodes, learningtrace.Node{
				ID: node.ID, Tag: node.Tag, Role: node.Role, Name: node.Name,
				CSS: node.CSS, Attributes: semanticAttributes(node.Attributes),
			})
		}
		for _, collection := range page.Collections {
			copyPage.Collections = append(copyPage.Collections, learningtrace.Collection{
				ParentCSS: collection.ParentCSS, ItemCSS: collection.ItemCSS, Count: collection.Count,
			})
		}
		input.Pages = append(input.Pages, copyPage)
	}
	for _, transition := range graph.Transitions {
		copyTransition := transition
		copyTransition.Action.Value.Value = nil
		copyTransition.Action.Target.Text = ""
		copyTransition.Action.Target.Attributes = semanticAttributes(transition.Action.Target.Attributes)
		input.Transitions = append(input.Transitions, copyTransition)
	}
	return input
}

func graphFromSemanticInput(input SemanticInput) learningtrace.Graph {
	return learningtrace.Graph{
		TraceID: input.TraceID, Origin: input.Origin, RootPageID: input.RootPageID,
		FinalPageID: input.FinalPageID, Pages: input.Pages, Transitions: input.Transitions,
	}
}

func semanticAttributes(attributes map[string]string) map[string]string {
	allowed := map[string]bool{
		"id": true, "name": true, "type": true, "placeholder": true,
		"href": true, "data-testid": true, "data-test": true, "data-qa": true,
		"aria-label": true,
	}
	result := map[string]string{}
	for key, value := range attributes {
		if allowed[strings.ToLower(key)] {
			result[key] = value
		}
	}
	return result
}

// ValidateSemanticResult is the single validation gate used for fake and
// network semanticizers. It treats all labels as proposals and all executable
// structure as a claim that must be supported by the deterministic graph.
func ValidateSemanticResult(graph learningtrace.Graph, result SemanticResult) []Diagnostic {
	var diagnostics []Diagnostic
	if err := result.ActionMap.Validate(); err != nil {
		diagnostics = append(diagnostics, Diagnostic{Code: "ACTION_MAP_INVALID", Path: "$", Message: err.Error()})
	}
	encoded, err := json.Marshal(result.ActionMap)
	if err == nil {
		findings, scanErr := privacy.Scan(encoded)
		if scanErr != nil {
			diagnostics = append(diagnostics, Diagnostic{Code: "PRIVACY_SCAN_FAILED", Path: "$", Message: scanErr.Error()})
		}
		for _, finding := range findings {
			diagnostics = append(diagnostics, Diagnostic{Code: "SENSITIVE_RECONSTRUCTION", Path: finding.Path, Message: "semantic output contains " + finding.Category})
		}
	}
	if result.ActionMap.Site.Origin != graph.Origin {
		diagnostics = append(diagnostics, Diagnostic{Code: "ORIGIN_NOT_OBSERVED", Path: "$.site.origin", Message: "site origin must equal the observed trace origin"})
	}
	pageByID := map[string]learningtrace.Page{}
	for _, page := range graph.Pages {
		pageByID[page.ID] = page
	}
	transitionByID := map[string]learningtrace.Transition{}
	actionByID := map[string]learningtrace.Transition{}
	for _, transition := range graph.Transitions {
		transitionByID[transition.ID] = transition
		actionByID[transition.ActionID] = transition
	}
	states := map[string]actionmap.State{}
	for index, state := range result.ActionMap.States {
		path := fmt.Sprintf("$.states[%d]", index)
		states[state.ID] = state
		if len(state.Evidence) == 0 {
			diagnostics = append(diagnostics, Diagnostic{Code: "EVIDENCE_REQUIRED", Path: path + ".evidence", Message: "state must cite an observed page id"})
		}
		for evidenceIndex, evidenceID := range state.Evidence {
			page, exists := pageByID[evidenceID]
			if !exists {
				diagnostics = append(diagnostics, Diagnostic{Code: "INVENTED_EVIDENCE", Path: fmt.Sprintf("%s.evidence[%d]", path, evidenceIndex), Message: "state evidence id was not observed"})
				continue
			}
			pattern, patternErr := regexp.Compile(state.URLPattern)
			if patternErr != nil || !pattern.MatchString(page.URL) {
				diagnostics = append(diagnostics, Diagnostic{Code: "STATE_NOT_OBSERVED", Path: path + ".urlPattern", Message: "state pattern must match its cited page evidence"})
			}
		}
	}
	for actionIndex, action := range result.ActionMap.Actions {
		path := fmt.Sprintf("$.actions[%d]", actionIndex)
		var cited []learningtrace.Transition
		for evidenceIndex, evidenceID := range action.Evidence {
			if transition, exists := transitionByID[evidenceID]; exists {
				cited = append(cited, transition)
				continue
			}
			if transition, exists := actionByID[evidenceID]; exists {
				cited = append(cited, transition)
				continue
			}
			diagnostics = append(diagnostics, Diagnostic{Code: "INVENTED_EVIDENCE", Path: fmt.Sprintf("%s.evidence[%d]", path, evidenceIndex), Message: "action evidence id was not observed"})
		}
		cited = uniqueTransitions(cited)
		if len(cited) == 0 {
			diagnostics = append(diagnostics, Diagnostic{Code: "EVIDENCE_REQUIRED", Path: path + ".evidence", Message: "action must cite an observed transition"})
			continue
		}
		if _, exists := states[action.FromState]; !exists {
			continue
		}
		if !containsString(states[action.FromState].Evidence, cited[0].FromPageID) {
			diagnostics = append(diagnostics, Diagnostic{Code: "STATE_TRANSITION_MISMATCH", Path: path + ".fromState", Message: "entry state does not cite the transition source page"})
		}
		if action.ToState != nil && !containsString(states[*action.ToState].Evidence, cited[len(cited)-1].ToPageID) {
			diagnostics = append(diagnostics, Diagnostic{Code: "STATE_TRANSITION_MISMATCH", Path: path + ".toState", Message: "terminal state does not cite the transition result page"})
		}
		observedKinds := make([]string, 0, len(cited))
		for _, transition := range cited {
			observedKinds = append(observedKinds, transition.Action.Kind)
		}
		observedIndex := 0
		for stepIndex, step := range action.Steps {
			stepPath := fmt.Sprintf("%s.steps[%d]", path, stepIndex)
			if step.Operation == "wait" || step.Operation == "extract" {
				continue
			}
			if observedIndex >= len(observedKinds) || step.Operation != observedKinds[observedIndex] {
				diagnostics = append(diagnostics, Diagnostic{Code: "UNOBSERVED_TRANSITION", Path: stepPath + ".op", Message: "step operation is not present in cited transition order"})
				continue
			}
			observed := cited[observedIndex]
			if !locatorSupportedBy(step.Target, observed.Action.Target) {
				diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: stepPath + ".target", Message: "locator is not supported by the cited action target"})
			}
			if (step.Operation == "fill" || step.Operation == "click" || step.Operation == "press") && step.Expect.Kind == "none" {
				diagnostics = append(diagnostics, Diagnostic{Code: "POSTCONDITION_REQUIRED", Path: stepPath + ".expect", Message: "observed operation requires an explicit postcondition"})
			}
			if step.Operation == "fill" && step.ValueFrom != nil && !observed.Action.Value.Redacted {
				diagnostics = append(diagnostics, Diagnostic{Code: "ARGUMENT_NOT_OBSERVED", Path: stepPath + ".valueFrom", Message: "argument requires tokenized user-input evidence"})
			}
			if step.Expect.Kind == "navigation" && !observed.Update.URLChanged {
				diagnostics = append(diagnostics, Diagnostic{Code: "POSTCONDITION_NOT_OBSERVED", Path: stepPath + ".expect.kind", Message: "navigation was not observed for this transition"})
			}
			if (step.Expect.Kind == "element" || step.Expect.Kind == "collection") && !locatorSupportedByPage(step.Expect.Target, pageByID[observed.ToPageID]) {
				diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: stepPath + ".expect.target", Message: "postcondition locator is not present in cited resulting-page evidence"})
			}
			observedIndex++
		}
		if observedIndex != len(observedKinds) {
			diagnostics = append(diagnostics, Diagnostic{Code: "EVIDENCE_UNUSED", Path: path + ".steps", Message: "steps do not account for every cited observed transition"})
		}
		for parameterIndex := range action.Parameters {
			found := false
			for _, transition := range cited {
				if transition.Action.Kind == "fill" && transition.Action.Value.Redacted {
					found = true
				}
			}
			if !found {
				diagnostics = append(diagnostics, Diagnostic{Code: "ARGUMENT_NOT_OBSERVED", Path: fmt.Sprintf("%s.parameters[%d]", path, parameterIndex), Message: "parameter has no tokenized input evidence"})
			}
		}
		if effectSeverity(cited) > safetySeverity(action.Safety) {
			diagnostics = append(diagnostics, Diagnostic{Code: "SAFETY_UNDERCLASSIFIED", Path: path + ".safety", Message: "safety is less restrictive than the observed effect"})
		}
		if action.Output.Mode != "none" {
			terminalPage := pageByID[cited[len(cited)-1].ToPageID]
			if action.Output.Mode == "collection" {
				if !locatorSupportedByPage(action.Output.CollectionRoot, terminalPage) {
					diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: path + ".output.collectionRoot", Message: "collection root is not present in terminal evidence"})
				}
				if !locatorSupportedByPage(action.Output.Item, terminalPage) {
					diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: path + ".output.item", Message: "collection item is not present in terminal evidence"})
				}
			}
			for fieldIndex, field := range action.Output.Fields {
				if !locatorSupportedByPage(field.Locator, terminalPage) {
					diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: fmt.Sprintf("%s.output.fields[%d].locator", path, fieldIndex), Message: "output field locator is not present in terminal evidence"})
				}
			}
		}
	}
	sort.SliceStable(diagnostics, func(left, right int) bool { return diagnostics[left].Path < diagnostics[right].Path })
	return diagnostics
}

func locatorSupportedBy(locator actionmap.Locator, target learningtrace.Node) bool {
	checks := 0
	matched := 0
	compare := func(proposed *string, observed string) {
		if proposed == nil || strings.TrimSpace(*proposed) == "" {
			return
		}
		checks++
		if strings.TrimSpace(*proposed) == strings.TrimSpace(observed) {
			matched++
		}
	}
	compare(locator.Role, target.Role)
	compare(locator.Name, target.Name)
	compare(locator.Placeholder, target.Attributes["placeholder"])
	compare(locator.CSS, target.CSS)
	if locator.HrefContains != nil {
		checks++
		if strings.Contains(target.Attributes["href"], *locator.HrefContains) {
			matched++
		}
	}
	if locator.Text != nil {
		checks++
		if *locator.Text == target.Text || *locator.Text == target.Name {
			matched++
		}
	}
	return checks > 0 && checks == matched
}

func locatorSupportedByPage(locator actionmap.Locator, page learningtrace.Page) bool {
	for _, node := range page.Nodes {
		if locatorSupportedBy(locator, node) {
			return true
		}
	}
	if locator.CSS != nil {
		for _, collection := range page.Collections {
			if *locator.CSS == collection.ParentCSS || *locator.CSS == collection.ItemCSS {
				return true
			}
		}
	}
	return false
}

func uniqueTransitions(transitions []learningtrace.Transition) []learningtrace.Transition {
	seen := map[string]bool{}
	result := make([]learningtrace.Transition, 0, len(transitions))
	for _, transition := range transitions {
		if !seen[transition.ID] {
			seen[transition.ID] = true
			result = append(result, transition)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ActionFrameSequence < result[j].ActionFrameSequence })
	return result
}

func effectSeverity(transitions []learningtrace.Transition) int {
	severity := 0
	for _, transition := range transitions {
		name := strings.ToLower(transition.Action.Target.Name + " " + transition.Action.Target.Attributes["type"])
		if strings.Contains(name, "purchase") || strings.Contains(name, "place order") || strings.Contains(name, "pay") || strings.Contains(name, "delete") {
			severity = max(severity, 2)
		} else if transition.Action.Kind == "click" && (strings.Contains(name, "add") || strings.Contains(name, "submit") || strings.Contains(name, "save")) {
			severity = max(severity, 1)
		}
	}
	return severity
}

func safetySeverity(safety string) int {
	if safety == "danger" {
		return 2
	}
	if safety == "write" {
		return 1
	}
	return 0
}

type FakeSemanticizer struct{}

func (FakeSemanticizer) Semanticize(_ context.Context, input SemanticInput) (SemanticResult, error) {
	if len(input.Pages) == 0 || len(input.Transitions) == 0 {
		return SemanticResult{}, fmt.Errorf("semantic input has no observed workflow")
	}
	pages := map[string]learningtrace.Page{}
	for _, page := range input.Pages {
		pages[page.ID] = page
	}
	first := input.Transitions[0]
	selected := []learningtrace.Transition{first}
	for _, transition := range input.Transitions[1:] {
		selected = append(selected, transition)
		if transition.Update.URLChanged || len(pages[transition.ToPageID].Collections) > 0 {
			break
		}
	}
	fromPage := pages[selected[0].FromPageID]
	toPage := pages[selected[len(selected)-1].ToPageID]
	fromStateID := stateIdentifier(fromPage, "catalog")
	toStateID := stateIdentifier(toPage, "result")
	if toStateID == fromStateID {
		toStateID += "_result"
	}
	states := []actionmap.State{
		{ID: fromStateID, Label: stateLabel(fromPage, "Catalog"), URLPattern: observedURLPattern(fromPage.URL), Fingerprint: stringPointer(fromPage.Fingerprint), Evidence: []string{fromPage.ID}},
		{ID: toStateID, Label: stateLabel(toPage, "Result"), URLPattern: observedURLPattern(toPage.URL), Fingerprint: stringPointer(toPage.Fingerprint), Evidence: []string{toPage.ID}},
	}
	parameters := []actionmap.Parameter{}
	steps := []actionmap.Step{}
	for _, transition := range selected {
		step := actionmap.Step{Operation: transition.Action.Kind, Target: actionLocator(transition.Action.Target), TimeoutMS: 10000}
		switch transition.Action.Kind {
		case "fill":
			parameterName := "query"
			parameters = append(parameters, actionmap.Parameter{Name: parameterName, Description: "Text to enter in the observed field", Type: "string", Required: true})
			step.ValueFrom = stringPointer(parameterName)
			step.Expect = actionmap.Expectation{Kind: "dom_change"}
		case "click", "press":
			if transition.Update.URLChanged {
				step.Expect = actionmap.Expectation{Kind: "navigation", State: stringPointer(toStateID), URLPattern: stringPointer(observedURLPattern(toPage.URL))}
			} else {
				step.Expect = actionmap.Expectation{Kind: "dom_change", State: stringPointer(toStateID)}
			}
		default:
			return SemanticResult{}, fmt.Errorf("fake semanticizer does not support observed %s actions", transition.Action.Kind)
		}
		steps = append(steps, step)
	}
	evidence := make([]string, 0, len(selected))
	for _, transition := range selected {
		evidence = append(evidence, transition.ID)
	}
	output := conservativeOutput(toPage)
	if output.Mode != "none" {
		steps = append(steps, actionmap.Step{
			Operation: "extract", Expect: actionmap.Expectation{Kind: "collection", Target: output.Item},
			TimeoutMS: 5000,
		})
	}
	action := actionmap.Action{
		ID: "search_products", Name: "Search products", Description: "Search the observed catalog",
		Category: "read", Status: "observed", Safety: "read", Confidence: 1,
		FromState: fromStateID, ToState: stringPointer(toStateID), Parameters: parameters,
		Steps: steps, Output: output, Evidence: evidence, MissingEvidence: []string{},
	}
	resultMap := actionmap.Map{
		SchemaVersion: actionmap.SchemaVersion,
		Site:          actionmap.Site{Origin: input.Origin, ObservedURLs: observedURLs(input.Pages)},
		Summary:       "Observed browser workflow", States: states, Actions: []actionmap.Action{action},
		Warnings: []string{}, Privacy: actionmap.Privacy{Policy: "Sensitive values removed before semanticization"},
	}
	encoded, _ := json.Marshal(resultMap)
	digest := sha256.Sum256(encoded)
	return SemanticResult{ActionMap: resultMap, Provider: "fake", Model: "deterministic", PromptVersion: SemanticPromptVersion, ResponseDigest: "sha256:" + hex.EncodeToString(digest[:])}, nil
}

func actionLocator(target learningtrace.Node) actionmap.Locator {
	locator := actionmap.Locator{}
	if target.Role != "" {
		locator.Role = stringPointer(target.Role)
	}
	if target.Name != "" {
		locator.Name = stringPointer(target.Name)
	}
	if placeholder := target.Attributes["placeholder"]; placeholder != "" {
		locator.Placeholder = stringPointer(placeholder)
	}
	if target.CSS != "" && !generatedSelector(target.CSS) {
		locator.CSS = stringPointer(target.CSS)
	}
	if href := target.Attributes["href"]; href != "" {
		if parsed, err := url.Parse(href); err == nil {
			locator.HrefContains = stringPointer(parsed.Path)
		}
	}
	return locator
}

func conservativeOutput(page learningtrace.Page) actionmap.Output {
	if len(page.Collections) == 0 {
		return actionmap.Output{Mode: "none", Limit: 1, Fields: []actionmap.OutputField{}}
	}
	collection := page.Collections[0]
	root, item := actionmap.Locator{}, actionmap.Locator{}
	if collection.ParentCSS != "" && !generatedSelector(collection.ParentCSS) {
		root.CSS = stringPointer(collection.ParentCSS)
	}
	if collection.ItemCSS != "" && !generatedSelector(collection.ItemCSS) {
		item.CSS = stringPointer(collection.ItemCSS)
	}
	if !item.HasEvidence() {
		return actionmap.Output{Mode: "none", Limit: 1, Fields: []actionmap.OutputField{}}
	}
	var linkPath string
	for _, node := range page.Nodes {
		href := node.Attributes["href"]
		parsed, err := url.Parse(href)
		if node.Role != "link" || err != nil || parsed.Path == "" {
			continue
		}
		lastSlash := strings.LastIndex(parsed.Path, "/")
		if lastSlash >= 0 {
			linkPath = parsed.Path[:lastSlash+1]
		}
		if linkPath != "" {
			break
		}
	}
	if linkPath == "" {
		return actionmap.Output{Mode: "none", Limit: 1, Fields: []actionmap.OutputField{}}
	}
	fieldLocator := actionmap.Locator{HrefContains: stringPointer(linkPath)}
	limit := collection.Count
	if limit < 1 {
		limit = 1
	}
	if limit > 25 {
		limit = 25
	}
	return actionmap.Output{
		Mode: "collection", CollectionRoot: root, Item: item, Limit: limit,
		Fields: []actionmap.OutputField{
			{Name: "name", Locator: fieldLocator, Required: true},
			{Name: "url", Locator: fieldLocator, Attribute: stringPointer("href"), Required: true},
		},
	}
}

func observedURLs(pages []learningtrace.Page) []string {
	seen := map[string]bool{}
	var values []string
	for _, page := range pages {
		if page.URL != "" && !seen[page.URL] {
			seen[page.URL] = true
			values = append(values, page.URL)
		}
	}
	return values
}
func observedURLPattern(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "^" + regexp.QuoteMeta(rawURL) + "$"
	}
	base := parsed.Scheme + "://" + parsed.Host + parsed.Path
	return "^" + regexp.QuoteMeta(base) + "(?:\\?.*)?$"
}
func stateIdentifier(page learningtrace.Page, fallback string) string {
	return identifierString(page.Fingerprint, fallback)
}
func stateLabel(page learningtrace.Page, fallback string) string {
	if page.Fingerprint != "" {
		words := strings.Fields(strings.ReplaceAll(page.Fingerprint, "_", " "))
		for index, word := range words {
			if word != "" {
				words[index] = strings.ToUpper(word[:1]) + word[1:]
			}
		}
		if label := strings.Join(words, " "); label != "" {
			return label
		}
	}
	return fallback
}
func identifierString(value, fallback string) string {
	var builder strings.Builder
	for _, character := range strings.ToLower(value) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '_' {
			builder.WriteRune(character)
		} else if builder.Len() > 0 {
			builder.WriteByte('_')
		}
	}
	result := strings.Trim(builder.String(), "_")
	if result == "" || result[0] < 'a' || result[0] > 'z' {
		result = fallback
	}
	if len(result) > 40 {
		result = result[:40]
	}
	return result
}
func stringPointer(value string) *string { return &value }
func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
func generatedSelector(selector string) bool {
	lower := strings.ToLower(selector)
	return strings.Contains(lower, ":nth-") || strings.Contains(lower, ">") || strings.Count(selector, " ") > 3 || strings.Contains(lower, "[class*=")
}
