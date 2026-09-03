package learning

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/manifest"
	learningtrace "webmcp-automator/server/internal/trace"
)

// CompileAmbientCandidate makes the existing action-list/1 review artifact
// from an accepted action-map revision. It is a projection, never publication:
// policy remains unknown and every action remains candidate.
func CompileAmbientCandidate(scopeID string, snapshot actionmap.Map, mapRevision int, mapDigest string, now time.Time) (json.RawMessage, error) {
	if err := snapshot.Validate(); err != nil {
		return nil, fmt.Errorf("validate source action map: %w", err)
	}
	if diagnostics := compilerDiagnostics(snapshot); len(diagnostics) > 0 {
		return nil, fmt.Errorf("action map is not review-projectable: %s", diagnostics[0].Code)
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	traceID := boundedIdentifier(scopeID + "_ambient")
	sourceMapID := boundedIdentifier(fmt.Sprintf("%s_map_%d", scopeID, mapRevision))
	states := make([]any, 0, len(snapshot.States))
	routes := make([]string, 0, len(snapshot.States))
	for _, state := range snapshot.States {
		states = append(states, map[string]any{
			"id": state.ID, "label": state.Label, "description": "Ambient semantic state: " + state.Label,
			"match": map[string]any{"mode": "all", "checks": []any{map[string]any{"kind": "url", "pattern": state.URLPattern}}},
		})
		routes = append(routes, state.URLPattern)
	}
	actions := make([]any, 0, len(snapshot.Actions))
	for _, action := range snapshot.Actions {
		toState := action.FromState
		if action.ToState != nil {
			toState = *action.ToState
		}
		transition := learningtrace.Transition{ID: boundedIdentifier(action.ID + "_ambient"), FromPageID: action.FromState, ToPageID: toState, ActionFrameSequence: 1, UpdateFrameSequence: 2}
		steps := make([]any, 0, len(action.Steps))
		for index, step := range action.Steps {
			steps = append(steps, compileStep(step, index, transition, action, traceID))
		}
		properties := map[string]any{}
		required := []string{}
		for _, parameter := range action.Parameters {
			properties[parameter.Name] = map[string]any{"type": parameter.Type, "description": parameter.Description}
			if parameter.Required {
				required = append(required, parameter.Name)
			}
		}
		readOnly := action.Safety == "read"
		actions = append(actions, map[string]any{
			"id": action.ID, "version": 1, "lifecycle": "candidate",
			"tool": map[string]any{"name": action.ID, "title": action.Name, "description": action.Description,
				"inputSchema": map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false},
				"annotations": map[string]any{"readOnlyHint": readOnly, "untrustedContentHint": true}},
			"precondition": map[string]any{"allowedStateIds": []string{action.FromState}, "urlPatterns": []string{stateByID(snapshot.States, action.FromState).URLPattern}, "checks": map[string]any{"mode": "all", "checks": []any{map[string]any{"kind": "state", "stateId": action.FromState}}}},
			"steps":        steps, "output": compileOutput(action.Output), "safety": compileSafety(action, steps),
			"runtime":    map[string]any{"executionSurface": "inactive_tab", "allowedOrigins": []string{snapshot.Site.Origin}, "maxDurationMs": boundedDuration(action.Steps), "maxNavigations": ambientNavigations(action), "closeExecutionTab": true},
			"provenance": map[string]any{"source": "imported", "observationCount": ambientObservationCount(action), "traceIds": ambientTraceIDs(action, traceID), "compiler": "ambient action-map projection; source revision " + fmt.Sprint(mapRevision) + "; source digest " + mapDigest + "; evidence bindings retained in action-map revision", "compiledAt": now.UTC().Format(time.RFC3339), "reviewedAt": nil, "reviewedBy": nil},
		})
	}
	document := map[string]any{"schemaVersion": manifest.ActionListSchemaVersion, "listId": AmbientCandidateListID(scopeID), "site": map[string]any{"origin": snapshot.Site.Origin, "routePatterns": uniqueRoutes(routes), "topFrameOnly": true}, "publication": map[string]any{"status": "candidate", "revision": mapRevision, "createdAt": now.UTC().Format(time.RFC3339), "updatedAt": now.UTC().Format(time.RFC3339), "sourceMapId": sourceMapID, "contentDigest": nil}, "policy": map[string]any{"status": "unknown", "scopes": []string{}, "basis": "unreviewed", "evidenceUrl": nil, "checkedAt": now.UTC().Format(time.RFC3339), "expiresAt": nil, "reviewedBy": "local user", "note": "Candidate generated from ambient action-map revision; independent policy and replay review are required before publication."}, "states": states, "actions": actions}
	raw, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	if _, err := manifest.DecodeActionList(raw); err != nil {
		return nil, fmt.Errorf("validate projected action list: %w", err)
	}
	return raw, nil
}

func AmbientCandidateListID(scopeID string) string { return boundedIdentifier(scopeID + "_actions") }

func ambientObservationCount(action actionmap.Action) int {
	for _, handle := range action.Evidence {
		if strings.Contains(handle, ":update_") || strings.Contains(handle, ":obs_") {
			return 1
		}
	}
	return 1 // action-list/1 requires provenance evidence; map-only inference is a candidate, never publishable.
}

func ambientTraceIDs(action actionmap.Action, fallback string) []string {
	seen := map[string]bool{}
	values := []string{}
	for _, handle := range action.Evidence {
		parts := strings.Split(handle, ":")
		if len(parts) > 0 && !seen[parts[0]] {
			seen[parts[0]] = true
			values = append(values, parts[0])
		}
	}
	if len(values) == 0 {
		return []string{fallback}
	}
	return values
}

func ambientNavigations(action actionmap.Action) int {
	count := 0
	for _, step := range action.Steps {
		if step.Expect.Kind == "navigation" {
			count++
		}
	}
	return count
}

func uniqueRoutes(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	if len(result) == 0 {
		return []string{"^/$"}
	}
	return result
}
