package learning

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"webmcp-automator/server/internal/actionmap"
	learningtrace "webmcp-automator/server/internal/trace"
)

type PolicyTemplate struct {
	Status      string
	Scopes      []string
	Basis       string
	EvidenceURL *string
	CheckedAt   time.Time
	ExpiresAt   *time.Time
	ReviewedBy  string
	Note        string
}

type CompilerOptions struct {
	Now      time.Time
	Revision int
	Policy   PolicyTemplate
}

type CompilationResult struct {
	ActionList  json.RawMessage `json:"actionList,omitempty"`
	Diagnostics []Diagnostic    `json:"diagnostics"`
}

// Compile projects a validated semantic proposal into the frozen action-list/1
// contract. It never calls a model and never adds an operation absent from the
// deterministic evidence graph.
func Compile(graph learningtrace.Graph, semantic SemanticResult, options CompilerOptions) CompilationResult {
	diagnostics := ValidateSemanticResult(graph, semantic)
	diagnostics = append(diagnostics, compilerDiagnostics(semantic.ActionMap)...)
	diagnostics = normalizeDiagnostics(diagnostics)
	if len(diagnostics) > 0 {
		return CompilationResult{Diagnostics: diagnostics}
	}
	if options.Now.IsZero() {
		options.Now = time.Unix(0, 0).UTC()
	}
	if options.Revision < 1 {
		options.Revision = 1
	}
	if options.Policy.Status == "" {
		options.Policy = PolicyTemplate{
			Status: "unknown", Scopes: []string{}, Basis: "unreviewed",
			CheckedAt: options.Now, ReviewedBy: "local user",
			Note: "Candidate requires an independent policy review before publication.",
		}
	}
	pageByID := map[string]learningtrace.Page{}
	for _, page := range graph.Pages {
		pageByID[page.ID] = page
	}
	transitionByID := map[string]learningtrace.Transition{}
	for _, transition := range graph.Transitions {
		transitionByID[transition.ID] = transition
		transitionByID[transition.ActionID] = transition
	}
	states := make([]any, 0, len(semantic.ActionMap.States))
	usedPageIDs := map[string]bool{}
	for _, state := range semantic.ActionMap.States {
		checks := []any{map[string]any{"kind": "url", "pattern": state.URLPattern}}
		if len(state.Evidence) > 0 {
			usedPageIDs[state.Evidence[0]] = true
			page := pageByID[state.Evidence[0]]
			if len(page.Nodes) > 0 {
				if locator := compileLocator(actionLocator(page.Nodes[0]), "one", true, false); locator != nil {
					checks = append(checks, map[string]any{"kind": "element", "target": locator, "assertion": "visible"})
				}
			}
		}
		states = append(states, map[string]any{
			"id": state.ID, "label": state.Label,
			"description": "Observed page state: " + state.Label + ".",
			"match":       map[string]any{"mode": "all", "checks": checks},
		})
	}
	actions := make([]any, 0, len(semantic.ActionMap.Actions))
	for _, action := range semantic.ActionMap.Actions {
		cited := citedTransitions(action, transitionByID)
		for _, transition := range cited {
			usedPageIDs[transition.FromPageID] = true
			usedPageIDs[transition.ToPageID] = true
		}
		steps := make([]any, 0, len(action.Steps))
		observedIndex := 0
		for stepIndex, step := range action.Steps {
			transition := cited[len(cited)-1]
			if step.Operation != "wait" && step.Operation != "extract" {
				transition = cited[observedIndex]
				observedIndex++
			}
			steps = append(steps, compileStep(step, stepIndex, transition, action, graph.TraceID))
		}
		inputProperties := map[string]any{}
		required := []string{}
		for _, parameter := range action.Parameters {
			inputProperties[parameter.Name] = map[string]any{"type": parameter.Type, "description": parameter.Description}
			if parameter.Required {
				required = append(required, parameter.Name)
			}
		}
		readOnly := action.Safety == "read"
		safety := compileSafety(action, steps)
		fromState := stateByID(semantic.ActionMap.States, action.FromState)
		preconditionChecks := []any{map[string]any{"kind": "state", "stateId": action.FromState}}
		actions = append(actions, map[string]any{
			"id": action.ID, "version": 1, "lifecycle": "candidate",
			"tool": map[string]any{
				"name": action.ID, "title": action.Name, "description": action.Description,
				"inputSchema": map[string]any{"type": "object", "properties": inputProperties, "required": required, "additionalProperties": false},
				"annotations": map[string]any{"readOnlyHint": readOnly, "untrustedContentHint": true},
			},
			"precondition": map[string]any{
				"allowedStateIds": []string{action.FromState}, "urlPatterns": []string{fromState.URLPattern},
				"checks": map[string]any{"mode": "all", "checks": preconditionChecks},
			},
			"steps": steps, "output": compileOutput(action.Output), "safety": safety,
			"runtime": map[string]any{
				"executionSurface": "inactive_tab", "allowedOrigins": []string{graph.Origin},
				"maxDurationMs": boundedDuration(action.Steps), "maxNavigations": observedNavigations(cited),
				"closeExecutionTab": true,
			},
			"provenance": map[string]any{
				"source": "demonstration", "observationCount": 1, "traceIds": []string{graph.TraceID},
				"compiler":   "deterministic action-map projection; semantic labels validated against evidence",
				"compiledAt": options.Now.UTC().Format(time.RFC3339), "reviewedAt": nil, "reviewedBy": nil,
			},
		})
	}
	checkedAt := options.Policy.CheckedAt
	if checkedAt.IsZero() {
		checkedAt = options.Now
	}
	var expiresAt any
	if options.Policy.ExpiresAt != nil {
		expiresAt = options.Policy.ExpiresAt.UTC().Format(time.RFC3339)
	}
	document := map[string]any{
		"schemaVersion": "action-list/1", "listId": boundedIdentifier(graph.TraceID + "_actions"),
		"site": map[string]any{"origin": graph.Origin, "routePatterns": routePatterns(selectedPages(graph.Pages, usedPageIDs)), "topFrameOnly": true},
		"publication": map[string]any{
			"status": "candidate", "revision": options.Revision,
			"createdAt": options.Now.UTC().Format(time.RFC3339), "updatedAt": options.Now.UTC().Format(time.RFC3339),
			"sourceMapId": boundedIdentifier(graph.TraceID + "_map"), "contentDigest": nil,
		},
		"policy": map[string]any{
			"status": options.Policy.Status, "scopes": options.Policy.Scopes, "basis": options.Policy.Basis,
			"evidenceUrl": options.Policy.EvidenceURL, "checkedAt": checkedAt.UTC().Format(time.RFC3339),
			"expiresAt": expiresAt, "reviewedBy": options.Policy.ReviewedBy, "note": options.Policy.Note,
		},
		"states": states, "actions": actions,
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return CompilationResult{Diagnostics: []Diagnostic{{Code: "ENCODE_FAILED", Path: "$", Message: err.Error()}}}
	}
	return CompilationResult{ActionList: encoded, Diagnostics: []Diagnostic{}}
}

func normalizeDiagnostics(diagnostics []Diagnostic) []Diagnostic {
	sort.SliceStable(diagnostics, func(left, right int) bool {
		if diagnostics[left].Path == diagnostics[right].Path {
			return diagnostics[left].Code < diagnostics[right].Code
		}
		return diagnostics[left].Path < diagnostics[right].Path
	})
	result := make([]Diagnostic, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		if len(result) > 0 && result[len(result)-1].Code == diagnostic.Code && result[len(result)-1].Path == diagnostic.Path {
			continue
		}
		result = append(result, diagnostic)
	}
	return result
}

func compilerDiagnostics(actionMap actionmap.Map) []Diagnostic {
	var diagnostics []Diagnostic
	for actionIndex, action := range actionMap.Actions {
		for stepIndex, step := range action.Steps {
			path := fmt.Sprintf("$.actions[%d].steps[%d]", actionIndex, stepIndex)
			if (step.Operation == "fill" || step.Operation == "click" || step.Operation == "press") && step.Expect.Kind == "none" {
				diagnostics = append(diagnostics, Diagnostic{Code: "POSTCONDITION_REQUIRED", Path: path + ".expect", Message: "consequential step requires a postcondition"})
			}
			if invalidLocator(step.Target) {
				diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: path + ".target", Message: "locator contains a generated selector or cannot be represented by action-list/1"})
			}
			if (step.Expect.Kind == "element" || step.Expect.Kind == "collection") && invalidLocator(step.Expect.Target) {
				diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: path + ".expect.target", Message: "postcondition locator is unsupported"})
			}
		}
		if action.Output.Mode != "none" {
			if len(action.Steps) == 0 || action.Steps[len(action.Steps)-1].Operation != "extract" {
				diagnostics = append(diagnostics, Diagnostic{Code: "EXTRACT_STEP_REQUIRED", Path: fmt.Sprintf("$.actions[%d].steps", actionIndex), Message: "non-none output requires a final extract step"})
			}
			for fieldIndex, field := range action.Output.Fields {
				if invalidLocator(field.Locator) {
					diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: fmt.Sprintf("$.actions[%d].output.fields[%d].locator", actionIndex, fieldIndex), Message: "output locator is unsupported"})
				}
				if field.Attribute != nil && !oneOfString(*field.Attribute, "text", "value", "href", "src", "checked", "selected") {
					diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_OUTPUT_READ", Path: fmt.Sprintf("$.actions[%d].output.fields[%d].attribute", actionIndex, fieldIndex), Message: "output read is not supported by action-list/1"})
				}
			}
			if action.Output.Mode == "collection" {
				if !action.Output.CollectionRoot.HasEvidence() || invalidLocator(action.Output.CollectionRoot) {
					diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: fmt.Sprintf("$.actions[%d].output.collectionRoot", actionIndex), Message: "collection root locator is unsupported"})
				}
				if !action.Output.Item.HasEvidence() || invalidLocator(action.Output.Item) {
					diagnostics = append(diagnostics, Diagnostic{Code: "UNSUPPORTED_LOCATOR", Path: fmt.Sprintf("$.actions[%d].output.item", actionIndex), Message: "collection item locator is unsupported"})
				}
			}
		}
	}
	return diagnostics
}

func invalidLocator(locator actionmap.Locator) bool {
	if locator.CSS != nil && generatedSelector(*locator.CSS) {
		return true
	}
	return locator.HasEvidence() && compileLocator(locator, "one", true, true) == nil
}

func compileStep(step actionmap.Step, index int, transition learningtrace.Transition, action actionmap.Action, traceID string) map[string]any {
	evidence := []any{evidenceReference(transition, traceID)}
	result := map[string]any{
		"id": boundedIdentifier(fmt.Sprintf("step_%d_%s", index+1, step.Operation)), "op": step.Operation,
		"expect": compileExpectation(step, transition, action), "timeoutMs": step.TimeoutMS, "evidence": evidence,
	}
	switch step.Operation {
	case "fill":
		result["target"] = compileLocator(step.Target, "one", true, true)
		if step.ValueFrom != nil {
			result["value"] = map[string]any{"fromArgument": *step.ValueFrom}
		} else {
			result["value"] = map[string]any{"literal": *step.LiteralValue}
		}
	case "click":
		result["target"] = compileLocator(step.Target, "one", true, true)
	case "press":
		result["target"] = compileLocator(step.Target, "one", true, true)
		result["key"] = valueOr(step.Key, "Enter")
	}
	return result
}

func compileExpectation(step actionmap.Step, transition learningtrace.Transition, action actionmap.Action) map[string]any {
	checks := []any{}
	if step.Operation == "fill" {
		value := map[string]any{}
		if step.ValueFrom != nil {
			value["fromArgument"] = *step.ValueFrom
		} else {
			value["literal"] = valueOr(step.LiteralValue, "")
		}
		checks = append(checks, map[string]any{"kind": "target_value", "value": value})
	} else {
		switch step.Expect.Kind {
		case "navigation":
			if step.Expect.URLPattern != nil {
				checks = append(checks, map[string]any{"kind": "url", "pattern": *step.Expect.URLPattern})
			}
			if step.Expect.State != nil {
				checks = append(checks, map[string]any{"kind": "state", "stateId": *step.Expect.State})
			}
		case "dom_change":
			if transition.Update.AddedCount+transition.Update.RemovedCount+transition.Update.ChangedCount > 0 {
				checks = append(checks, map[string]any{"kind": "dom_change", "minimumAdded": minimumObserved(transition.Update.AddedCount), "minimumRemoved": minimumObserved(transition.Update.RemovedCount), "minimumChanged": minimumObserved(transition.Update.ChangedCount)})
			} else if action.ToState != nil {
				checks = append(checks, map[string]any{"kind": "state", "stateId": *action.ToState})
			}
		case "collection":
			checks = append(checks, map[string]any{"kind": "collection", "target": compileLocator(step.Expect.Target, "many", true, false), "minimumItems": 0})
		case "element":
			checks = append(checks, map[string]any{"kind": "element", "target": compileLocator(step.Expect.Target, "one", true, false), "assertion": "visible"})
		}
	}
	if len(checks) == 0 && action.ToState != nil {
		checks = append(checks, map[string]any{"kind": "state", "stateId": *action.ToState})
	}
	return map[string]any{"mode": "all", "checks": checks}
}

func compileLocator(locator actionmap.Locator, cardinality string, visible bool, enabled bool) map[string]any {
	strategies := []any{}
	if locator.Role != nil && locator.Name != nil {
		strategies = append(strategies, map[string]any{"kind": "role", "role": *locator.Role, "name": *locator.Name, "exact": true})
	} else if locator.Role != nil && safeRoleName(*locator.Role) {
		strategies = append(strategies, map[string]any{"kind": "css", "selector": "[role='" + *locator.Role + "']"})
	}
	if locator.Placeholder != nil {
		strategies = append(strategies, map[string]any{"kind": "placeholder", "text": *locator.Placeholder, "exact": true})
	}
	if locator.HrefContains != nil {
		strategies = append(strategies, map[string]any{"kind": "href", "contains": *locator.HrefContains})
	}
	if locator.Text != nil {
		strategies = append(strategies, map[string]any{"kind": "text", "text": *locator.Text, "exact": true})
	}
	if locator.CSS != nil && !generatedSelector(*locator.CSS) {
		strategies = append(strategies, map[string]any{"kind": "css", "selector": *locator.CSS})
	}
	if len(strategies) == 0 {
		return nil
	}
	return map[string]any{"cardinality": cardinality, "visible": visible, "enabled": enabled, "strategies": strategies}
}

func safeRoleName(value string) bool {
	return regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`).MatchString(value)
}

func compileOutput(output actionmap.Output) any {
	if output.Mode == "none" {
		return map[string]any{"mode": "none"}
	}
	fields := []any{}
	for _, field := range output.Fields {
		read := "text"
		fieldType := "string"
		if field.Attribute != nil {
			read = *field.Attribute
			if read == "href" || read == "src" {
				fieldType = "url"
			}
		}
		fields = append(fields, map[string]any{"name": field.Name, "type": fieldType, "locator": compileLocator(field.Locator, "one", true, false), "read": read, "required": field.Required, "untrusted": true})
	}
	if output.Mode == "page" {
		return map[string]any{"mode": "page", "fields": fields}
	}
	return map[string]any{"mode": "collection", "collectionRoot": compileLocator(output.CollectionRoot, "one", true, false), "item": compileLocator(output.Item, "many", true, false), "limit": output.Limit, "fields": fields}
}

func compileSafety(action actionmap.Action, steps []any) map[string]any {
	if action.Safety == "read" {
		return map[string]any{"class": "read", "writesExternalState": false, "confirmation": "never", "confirmationStepId": nil, "idempotency": "safe", "sensitiveArguments": []string{}}
	}
	if action.Safety == "danger" {
		stepID := steps[0].(map[string]any)["id"]
		return map[string]any{"class": "danger", "writesExternalState": true, "confirmation": "before_step", "confirmationStepId": stepID, "idempotency": "unsafe", "sensitiveArguments": []string{}}
	}
	return map[string]any{"class": "write", "writesExternalState": true, "confirmation": "before_run", "confirmationStepId": nil, "idempotency": "conditional", "sensitiveArguments": []string{}}
}

func citedTransitions(action actionmap.Action, index map[string]learningtrace.Transition) []learningtrace.Transition {
	values := []learningtrace.Transition{}
	seen := map[string]bool{}
	for _, id := range action.Evidence {
		if transition, ok := index[id]; ok && !seen[transition.ID] {
			seen[transition.ID] = true
			values = append(values, transition)
		}
	}
	return uniqueTransitions(values)
}
func evidenceReference(transition learningtrace.Transition, traceID string) map[string]any {
	return map[string]any{"traceId": traceID, "transitionId": transition.ID, "fromPageId": transition.FromPageID, "actionFrameSequence": transition.ActionFrameSequence, "updateFrameSequence": transition.UpdateFrameSequence, "toPageId": transition.ToPageID}
}
func stateByID(states []actionmap.State, id string) actionmap.State {
	for _, state := range states {
		if state.ID == id {
			return state
		}
	}
	return actionmap.State{}
}
func observedNavigations(transitions []learningtrace.Transition) int {
	count := 0
	for _, transition := range transitions {
		if transition.Update.URLChanged {
			count++
		}
	}
	return count
}
func boundedDuration(steps []actionmap.Step) int {
	total := 0
	for _, step := range steps {
		total += step.TimeoutMS
	}
	if total < 1000 {
		return 1000
	}
	if total > 300000 {
		return 300000
	}
	return total
}
func minimumObserved(value int) int {
	if value > 0 {
		return 1
	}
	return 0
}
func valueOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}
func oneOfString(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
func routePatterns(pages []learningtrace.Page) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, page := range pages {
		parsed, err := url.Parse(page.URL)
		if err != nil {
			continue
		}
		pattern := "^" + regexp.QuoteMeta(parsed.Path) + "(?:\\?.*)?$"
		if !seen[pattern] {
			seen[pattern] = true
			result = append(result, pattern)
		}
	}
	return result
}
func selectedPages(pages []learningtrace.Page, selected map[string]bool) []learningtrace.Page {
	result := []learningtrace.Page{}
	for _, page := range pages {
		if selected[page.ID] {
			result = append(result, page)
		}
	}
	return result
}
func boundedIdentifier(value string) string {
	value = identifierString(value, "candidate")
	if len(value) > 40 {
		value = value[:40]
	}
	return strings.TrimSuffix(value, "_")
}
