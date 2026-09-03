package trace

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const SchemaVersion = "learning-trace/3"

type Metadata struct {
	RecordingID string
	StartURL    string
	FinalURL    string
}

// Graph is the deterministic, evidence-authoritative representation consumed by
// semanticizers. Labels may be proposed later, but these observed transitions
// cannot be added to or reordered by a model.
type Graph struct {
	TraceID     string       `json:"traceId"`
	Origin      string       `json:"origin"`
	RootPageID  string       `json:"rootPageId"`
	FinalPageID string       `json:"finalPageId"`
	Pages       []Page       `json:"pages"`
	Transitions []Transition `json:"transitions"`
}

type Page struct {
	ID          string       `json:"id"`
	Fingerprint string       `json:"fingerprint"`
	URL         string       `json:"url"`
	Title       string       `json:"title,omitempty"`
	Nodes       []Node       `json:"nodes,omitempty"`
	Collections []Collection `json:"collections,omitempty"`
}

type Node struct {
	ID         string            `json:"id"`
	Tag        string            `json:"tag,omitempty"`
	Role       string            `json:"role,omitempty"`
	Name       string            `json:"name,omitempty"`
	Text       string            `json:"text,omitempty"`
	CSS        string            `json:"css,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type Collection struct {
	ParentCSS string           `json:"parentCss,omitempty"`
	ItemCSS   string           `json:"itemCss,omitempty"`
	Count     int              `json:"count"`
	Sample    []CollectionItem `json:"sample,omitempty"`
}

type CollectionItem struct {
	Name       string            `json:"name,omitempty"`
	Text       string            `json:"text,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type ObservedAction struct {
	ID         string        `json:"id"`
	Kind       string        `json:"kind"`
	OccurredAt string        `json:"occurredAt,omitempty"`
	Target     Node          `json:"target"`
	Value      ObservedValue `json:"value"`
}

type ObservedValue struct {
	Redacted bool `json:"redacted"`
	Value    any  `json:"value"`
}

type ObservedUpdate struct {
	URLChanged         bool   `json:"urlChanged"`
	BeforeURL          string `json:"beforeUrl,omitempty"`
	AfterURL           string `json:"afterUrl,omitempty"`
	AddedCount         int    `json:"addedCount"`
	RemovedCount       int    `json:"removedCount"`
	ChangedCount       int    `json:"changedCount"`
	CollectionsChanged bool   `json:"collectionsChanged"`
}

type Transition struct {
	ID                  string         `json:"id"`
	FromPageID          string         `json:"fromPageId"`
	ActionID            string         `json:"actionId"`
	ActionFrameSequence int            `json:"actionFrameSequence"`
	UpdateFrameSequence int            `json:"updateFrameSequence"`
	ToPageID            string         `json:"toPageId"`
	Action              ObservedAction `json:"action"`
	Update              ObservedUpdate `json:"update"`
}

type pageReference struct {
	ID                 string `json:"id"`
	Fingerprint        string `json:"fingerprint"`
	FirstFrameSequence int    `json:"firstFrameSequence"`
}

type transition struct {
	ID                  string `json:"id"`
	FromPageID          string `json:"fromPageId"`
	ActionID            string `json:"actionId"`
	ActionFrameSequence int    `json:"actionFrameSequence"`
	UpdateFrameSequence int    `json:"updateFrameSequence"`
	ToPageID            string `json:"toPageId"`
}

type actionTree struct {
	Kind        string          `json:"kind"`
	RootPageID  string          `json:"rootPageId"`
	FinalPageID string          `json:"finalPageId"`
	Pages       []pageReference `json:"pages"`
	Transitions []transition    `json:"transitions"`
}

type pageEvidence struct {
	Fingerprint string
	URL         string
}

func Normalize(raw json.RawMessage) (json.RawMessage, Metadata, error) {
	if !json.Valid(raw) {
		return nil, Metadata{}, errors.New("trace must be valid JSON")
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, Metadata{}, fmt.Errorf("decode trace: %w", err)
	}
	if stringValue(document["schemaVersion"]) != SchemaVersion {
		return nil, Metadata{}, errors.New("trace schemaVersion must be " + SchemaVersion)
	}
	if err := allowOnly(document, "$", "schemaVersion", "recordingId", "startedAt", "stoppedAt", "frames", "actionTree"); err != nil {
		return nil, Metadata{}, err
	}
	rawFrames, ok := document["frames"].([]any)
	if !ok || len(rawFrames) < 4 {
		return nil, Metadata{}, errors.New("trace frames must contain a page, action, update, and resulting page")
	}

	pagesByID := map[string]pageEvidence{}
	pages := []pageReference{}
	transitions := []transition{}
	var metadata Metadata
	var currentPageID string
	var expectedPageID string
	var pendingActionID string
	var actionFrameSequence int
	var currentPageURL string
	var expectedPageURL string
	expectedType := "page"
	actionIDs := map[string]struct{}{}
	var previousActionTime time.Time
	startedAt, startedAtOK := optionalTime(document["startedAt"])
	stoppedAt, stoppedAtOK := optionalTime(document["stoppedAt"])
	if document["startedAt"] != nil && !startedAtOK {
		return nil, Metadata{}, errors.New("trace startedAt must be an RFC3339 timestamp")
	}
	if document["stoppedAt"] != nil && !stoppedAtOK {
		return nil, Metadata{}, errors.New("trace stoppedAt must be an RFC3339 timestamp")
	}
	if startedAtOK && stoppedAtOK && stoppedAt.Before(startedAt) {
		return nil, Metadata{}, errors.New("trace stoppedAt must not precede startedAt")
	}
	metadata.RecordingID = strings.TrimSpace(stringValue(document["recordingId"]))

	for index, rawFrame := range rawFrames {
		frame, ok := rawFrame.(map[string]any)
		if !ok {
			return nil, Metadata{}, fmt.Errorf("trace frame %d must be an object", index+1)
		}
		sequence := integerValue(frame["sequence"])
		if sequence != index+1 {
			return nil, Metadata{}, fmt.Errorf("trace frame %d has a non-contiguous sequence", index+1)
		}
		frameType := stringValue(frame["type"])
		if frameType != expectedType {
			return nil, Metadata{}, fmt.Errorf(
				"trace frame %d must be %s, got %s", sequence, expectedType, frameType,
			)
		}

		switch frameType {
		case "page":
			if err := allowOnly(frame, fmt.Sprintf("$.frames[%d]", index), "sequence", "type", "page"); err != nil {
				return nil, Metadata{}, err
			}
			page, ok := frame["page"].(map[string]any)
			if !ok {
				return nil, Metadata{}, fmt.Errorf("page frame %d is missing page evidence", sequence)
			}
			pageID := strings.TrimSpace(stringValue(page["id"]))
			fingerprint := strings.TrimSpace(stringValue(page["fingerprint"]))
			if pageID == "" || fingerprint == "" {
				return nil, Metadata{}, fmt.Errorf("page frame %d requires id and fingerprint", sequence)
			}
			if err := allowOnly(page, fmt.Sprintf("$.frames[%d].page", index), "id", "fingerprint", "url", "title", "viewport", "nodes", "collections", "truncated", "reused", "semanticXml"); err != nil {
				return nil, Metadata{}, err
			}
			if expectedPageID != "" && pageID != expectedPageID {
				return nil, Metadata{}, fmt.Errorf(
					"page frame %d must resolve update target %s", sequence, expectedPageID,
				)
			}
			evidence, seen := pagesByID[pageID]
			if !seen {
				url := strings.TrimSpace(stringValue(page["url"]))
				if url == "" || !validHTTPURL(url) {
					return nil, Metadata{}, fmt.Errorf(
						"first occurrence of page %s requires an HTTP or HTTPS URL", pageID,
					)
				}
				if metadata.StartURL != "" && originOf(url) != originOf(metadata.StartURL) {
					return nil, Metadata{}, fmt.Errorf("page %s changes the observed origin", pageID)
				}
				evidence = pageEvidence{Fingerprint: fingerprint, URL: url}
				pagesByID[pageID] = evidence
				pages = append(pages, pageReference{
					ID: pageID, Fingerprint: fingerprint, FirstFrameSequence: sequence,
				})
			} else if evidence.Fingerprint != fingerprint {
				return nil, Metadata{}, fmt.Errorf("page %s changed fingerprints", pageID)
			}
			if expectedPageURL != "" && evidence.URL != expectedPageURL {
				return nil, Metadata{}, fmt.Errorf("page frame %d URL does not match its preceding update", sequence)
			}
			currentPageID = pageID
			currentPageURL = evidence.URL
			expectedPageID = ""
			expectedPageURL = ""
			if metadata.StartURL == "" {
				metadata.StartURL = evidence.URL
			}
			metadata.FinalURL = evidence.URL
			expectedType = "action"
		case "action":
			if err := allowOnly(frame, fmt.Sprintf("$.frames[%d]", index), "sequence", "type", "fromPageId", "action"); err != nil {
				return nil, Metadata{}, err
			}
			fromPageID := strings.TrimSpace(stringValue(frame["fromPageId"]))
			action, ok := frame["action"].(map[string]any)
			if !ok {
				return nil, Metadata{}, fmt.Errorf("action frame %d is missing action evidence", sequence)
			}
			pendingActionID = strings.TrimSpace(stringValue(action["id"]))
			if fromPageID == "" || fromPageID != currentPageID || pendingActionID == "" {
				return nil, Metadata{}, fmt.Errorf(
					"action frame %d must reference its current page and an action id", sequence,
				)
			}
			if strings.TrimSpace(stringValue(action["kind"])) == "" {
				return nil, Metadata{}, fmt.Errorf("action frame %d requires an action kind", sequence)
			}
			if err := allowOnly(action, fmt.Sprintf("$.frames[%d].action", index), "id", "kind", "occurredAt", "target", "value", "synthetic"); err != nil {
				return nil, Metadata{}, err
			}
			kind := strings.TrimSpace(stringValue(action["kind"]))
			if kind != "fill" && kind != "click" && kind != "press" {
				return nil, Metadata{}, fmt.Errorf("action frame %d uses unsupported kind %s", sequence, kind)
			}
			if _, duplicate := actionIDs[pendingActionID]; duplicate {
				return nil, Metadata{}, fmt.Errorf("action frame %d duplicates action id %s", sequence, pendingActionID)
			}
			actionIDs[pendingActionID] = struct{}{}
			if rawTime := action["occurredAt"]; rawTime != nil {
				occurredAt, ok := optionalTime(rawTime)
				if !ok {
					return nil, Metadata{}, fmt.Errorf("action frame %d occurredAt must be an RFC3339 timestamp", sequence)
				}
				if (!previousActionTime.IsZero() && occurredAt.Before(previousActionTime)) ||
					(startedAtOK && occurredAt.Before(startedAt)) || (stoppedAtOK && occurredAt.After(stoppedAt)) {
					return nil, Metadata{}, fmt.Errorf("action frame %d is not chronological", sequence)
				}
				previousActionTime = occurredAt
			}
			actionFrameSequence = sequence
			expectedType = "update"
		case "update":
			if err := allowOnly(frame, fmt.Sprintf("$.frames[%d]", index), "sequence", "type", "actionId", "fromPageId", "toPageId", "update"); err != nil {
				return nil, Metadata{}, err
			}
			actionID := strings.TrimSpace(stringValue(frame["actionId"]))
			fromPageID := strings.TrimSpace(stringValue(frame["fromPageId"]))
			toPageID := strings.TrimSpace(stringValue(frame["toPageId"]))
			update, ok := frame["update"].(map[string]any)
			if !ok {
				return nil, Metadata{}, fmt.Errorf("update frame %d is missing change evidence", sequence)
			}
			if err := allowOnly(update, fmt.Sprintf("$.frames[%d].update", index), "urlChanged", "beforeUrl", "afterUrl", "titleChanged", "added", "removed", "changed", "collectionsChanged", "collections"); err != nil {
				return nil, Metadata{}, err
			}
			if actionID == "" || actionID != pendingActionID ||
				fromPageID != currentPageID || toPageID == "" {
				return nil, Metadata{}, fmt.Errorf(
					"update frame %d must connect its preceding action to a resulting page", sequence,
				)
			}
			beforeURL := strings.TrimSpace(stringValue(update["beforeUrl"]))
			afterURL := strings.TrimSpace(stringValue(update["afterUrl"]))
			if beforeURL != "" && beforeURL != currentPageURL {
				return nil, Metadata{}, fmt.Errorf("update frame %d beforeUrl does not match its source page", sequence)
			}
			if afterURL != "" {
				if !validHTTPURL(afterURL) || originOf(afterURL) != originOf(metadata.StartURL) {
					return nil, Metadata{}, fmt.Errorf("update frame %d afterUrl is outside the observed origin", sequence)
				}
				expectedPageURL = afterURL
			}
			transitions = append(transitions, transition{
				ID:                  fmt.Sprintf("transition_%d", len(transitions)+1),
				FromPageID:          fromPageID,
				ActionID:            actionID,
				ActionFrameSequence: actionFrameSequence,
				UpdateFrameSequence: sequence,
				ToPageID:            toPageID,
			})
			expectedPageID = toPageID
			pendingActionID = ""
			expectedType = "page"
		}
	}

	if expectedType != "action" || expectedPageID != "" {
		return nil, Metadata{}, errors.New("trace must end with the page produced by its final update")
	}
	if len(transitions) == 0 {
		return nil, Metadata{}, errors.New("trace must contain at least one observed action")
	}
	document["actionTree"] = actionTree{
		Kind:        "directed_action_graph",
		RootPageID:  pages[0].ID,
		FinalPageID: currentPageID,
		Pages:       pages,
		Transitions: transitions,
	}
	normalized, err := json.Marshal(document)
	if err != nil {
		return nil, Metadata{}, fmt.Errorf("encode normalized trace: %w", err)
	}
	return normalized, metadata, nil
}

// BuildGraph normalizes the trace first, then projects only observed evidence.
func BuildGraph(raw json.RawMessage) (Graph, error) {
	normalized, metadata, err := Normalize(raw)
	if err != nil {
		return Graph{}, err
	}
	var document map[string]any
	if err := json.Unmarshal(normalized, &document); err != nil {
		return Graph{}, fmt.Errorf("decode normalized trace: %w", err)
	}
	frames := document["frames"].([]any)
	pageByID := map[string]Page{}
	pageOrder := []string{}
	actionByID := map[string]ObservedAction{}
	updateByActionID := map[string]ObservedUpdate{}
	for _, rawFrame := range frames {
		frame := rawFrame.(map[string]any)
		switch stringValue(frame["type"]) {
		case "page":
			pageMap := frame["page"].(map[string]any)
			id := strings.TrimSpace(stringValue(pageMap["id"]))
			if existing, seen := pageByID[id]; seen {
				if rawURL := strings.TrimSpace(stringValue(pageMap["url"])); rawURL != "" && rawURL != existing.URL {
					return Graph{}, fmt.Errorf("reused page %s changed URLs", id)
				}
				continue
			}
			page := pageFromMap(pageMap)
			pageByID[id] = page
			pageOrder = append(pageOrder, id)
		case "action":
			actionMap := frame["action"].(map[string]any)
			actionByID[stringValue(actionMap["id"])] = actionFromMap(actionMap)
		case "update":
			updateMap := frame["update"].(map[string]any)
			updateByActionID[stringValue(frame["actionId"])] = updateFromMap(updateMap)
		}
	}
	var tree actionTree
	treeBytes, _ := json.Marshal(document["actionTree"])
	if err := json.Unmarshal(treeBytes, &tree); err != nil {
		return Graph{}, fmt.Errorf("decode deterministic action graph: %w", err)
	}
	graph := Graph{
		TraceID: identifier(metadata.RecordingID, "trace_observation"),
		Origin:  originOf(metadata.StartURL), RootPageID: tree.RootPageID,
		FinalPageID: tree.FinalPageID,
	}
	for _, id := range pageOrder {
		graph.Pages = append(graph.Pages, pageByID[id])
	}
	for _, edge := range tree.Transitions {
		graph.Transitions = append(graph.Transitions, Transition{
			ID: edge.ID, FromPageID: edge.FromPageID, ActionID: edge.ActionID,
			ActionFrameSequence: edge.ActionFrameSequence,
			UpdateFrameSequence: edge.UpdateFrameSequence, ToPageID: edge.ToPageID,
			Action: actionByID[edge.ActionID], Update: updateByActionID[edge.ActionID],
		})
	}
	return graph, nil
}

func pageFromMap(page map[string]any) Page {
	result := Page{ID: stringValue(page["id"]), Fingerprint: stringValue(page["fingerprint"]), URL: stringValue(page["url"]), Title: stringValue(page["title"])}
	for _, rawNode := range sliceValue(page["nodes"]) {
		if node, ok := rawNode.(map[string]any); ok {
			result.Nodes = append(result.Nodes, nodeFromMap(node))
		}
	}
	for _, rawCollection := range sliceValue(page["collections"]) {
		collection, ok := rawCollection.(map[string]any)
		if !ok {
			continue
		}
		entry := Collection{ParentCSS: stringValue(collection["parentCss"]), ItemCSS: stringValue(collection["itemCss"]), Count: integerValue(collection["count"])}
		for _, rawItem := range sliceValue(collection["sample"]) {
			if item, ok := rawItem.(map[string]any); ok {
				entry.Sample = append(entry.Sample, CollectionItem{Name: stringValue(item["name"]), Text: stringValue(item["text"]), Attributes: stringMap(item["attributes"])})
			}
		}
		result.Collections = append(result.Collections, entry)
	}
	return result
}

func nodeFromMap(node map[string]any) Node {
	return Node{ID: stringValue(node["id"]), Tag: stringValue(node["tag"]), Role: stringValue(node["role"]), Name: stringValue(node["name"]), Text: stringValue(node["text"]), CSS: stringValue(node["css"]), Attributes: stringMap(node["attributes"])}
}

func actionFromMap(action map[string]any) ObservedAction {
	result := ObservedAction{ID: stringValue(action["id"]), Kind: stringValue(action["kind"]), OccurredAt: stringValue(action["occurredAt"])}
	if target, ok := action["target"].(map[string]any); ok {
		result.Target = nodeFromMap(target)
	}
	if value, ok := action["value"].(map[string]any); ok {
		result.Value = ObservedValue{Redacted: boolValue(value["redacted"]), Value: value["value"]}
	}
	return result
}

func updateFromMap(update map[string]any) ObservedUpdate {
	return ObservedUpdate{URLChanged: boolValue(update["urlChanged"]), BeforeURL: stringValue(update["beforeUrl"]), AfterURL: stringValue(update["afterUrl"]), AddedCount: len(sliceValue(update["added"])), RemovedCount: len(sliceValue(update["removed"])), ChangedCount: len(sliceValue(update["changed"])), CollectionsChanged: boolValue(update["collectionsChanged"])}
}

func optionalTime(value any) (time.Time, bool) {
	text := strings.TrimSpace(stringValue(value))
	if text == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	return parsed, err == nil
}

func originOf(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func identifier(value string, fallback string) string {
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

func sliceValue(value any) []any { output, _ := value.([]any); return output }
func boolValue(value any) bool   { output, _ := value.(bool); return output }
func stringMap(value any) map[string]string {
	output := map[string]string{}
	if values, ok := value.(map[string]any); ok {
		for key, item := range values {
			if text, ok := item.(string); ok {
				output[key] = text
			}
		}
	}
	return output
}

func allowOnly(object map[string]any, path string, allowed ...string) error {
	set := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		set[key] = struct{}{}
	}
	for key := range object {
		if _, ok := set[key]; !ok {
			return fmt.Errorf("%s.%s is not allowed", path, key)
		}
	}
	return nil
}

func validHTTPURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https")
}

func integerValue(value any) int {
	number, ok := value.(float64)
	if !ok || number != float64(int(number)) {
		return 0
	}
	return int(number)
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}
