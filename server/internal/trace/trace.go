package trace

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const SchemaVersion = "learning-trace/3"

type Metadata struct {
	StartURL string
	FinalURL string
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
	expectedType := "page"

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
			page, ok := frame["page"].(map[string]any)
			if !ok {
				return nil, Metadata{}, fmt.Errorf("page frame %d is missing page evidence", sequence)
			}
			pageID := strings.TrimSpace(stringValue(page["id"]))
			fingerprint := strings.TrimSpace(stringValue(page["fingerprint"]))
			if pageID == "" || fingerprint == "" {
				return nil, Metadata{}, fmt.Errorf("page frame %d requires id and fingerprint", sequence)
			}
			if expectedPageID != "" && pageID != expectedPageID {
				return nil, Metadata{}, fmt.Errorf(
					"page frame %d must resolve update target %s", sequence, expectedPageID,
				)
			}
			evidence, seen := pagesByID[pageID]
			if !seen {
				url := strings.TrimSpace(stringValue(page["url"]))
				if url == "" {
					return nil, Metadata{}, fmt.Errorf(
						"first occurrence of page %s requires a URL", pageID,
					)
				}
				evidence = pageEvidence{Fingerprint: fingerprint, URL: url}
				pagesByID[pageID] = evidence
				pages = append(pages, pageReference{
					ID: pageID, Fingerprint: fingerprint, FirstFrameSequence: sequence,
				})
			} else if evidence.Fingerprint != fingerprint {
				return nil, Metadata{}, fmt.Errorf("page %s changed fingerprints", pageID)
			}
			currentPageID = pageID
			expectedPageID = ""
			if metadata.StartURL == "" {
				metadata.StartURL = evidence.URL
			}
			metadata.FinalURL = evidence.URL
			expectedType = "action"
		case "action":
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
			actionFrameSequence = sequence
			expectedType = "update"
		case "update":
			actionID := strings.TrimSpace(stringValue(frame["actionId"]))
			fromPageID := strings.TrimSpace(stringValue(frame["fromPageId"]))
			toPageID := strings.TrimSpace(stringValue(frame["toPageId"]))
			if _, ok := frame["update"].(map[string]any); !ok {
				return nil, Metadata{}, fmt.Errorf("update frame %d is missing change evidence", sequence)
			}
			if actionID == "" || actionID != pendingActionID ||
				fromPageID != currentPageID || toPageID == "" {
				return nil, Metadata{}, fmt.Errorf(
					"update frame %d must connect its preceding action to a resulting page", sequence,
				)
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
