package trace_test

import (
	"encoding/json"
	"strings"
	"testing"

	learningtrace "webmcp-automator/server/internal/trace"
)

func TestNormalizeBuildsActionTreeFromSteppedFrames(t *testing.T) {
	input := json.RawMessage(`{
		"schemaVersion":"learning-trace/3",
		"recordingId":"recording-1",
		"frames":[
			{"sequence":1,"type":"page","page":{"id":"page_1","fingerprint":"home","url":"https://shop.example/"}},
			{"sequence":2,"type":"action","fromPageId":"page_1","action":{"id":"action_1","kind":"fill"}},
			{"sequence":3,"type":"update","actionId":"action_1","fromPageId":"page_1","toPageId":"page_2","update":{"urlChanged":false}},
			{"sequence":4,"type":"page","page":{"id":"page_2","fingerprint":"results","url":"https://shop.example/search?q=private"}}
		],
		"actionTree":{"kind":"untrusted","transitions":[]}
	}`)
	output, metadata, err := learningtrace.Normalize(input)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if metadata.StartURL != "https://shop.example/" ||
		metadata.FinalURL != "https://shop.example/search?q=private" {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
	text := string(output)
	if strings.Contains(text, `"kind":"untrusted"`) ||
		!strings.Contains(text, `"kind":"directed_action_graph"`) ||
		!strings.Contains(text, `"actionFrameSequence":2`) {
		t.Fatalf("action tree was not rebuilt: %s", text)
	}
}

func TestNormalizeRejectsOutOfOrderFrames(t *testing.T) {
	input := json.RawMessage(`{
		"schemaVersion":"learning-trace/3",
		"frames":[
			{"sequence":1,"type":"page","page":{"id":"page_1","fingerprint":"home","url":"https://shop.example/"}},
			{"sequence":2,"type":"update","actionId":"action_1","fromPageId":"page_1","toPageId":"page_2","update":{}},
			{"sequence":3,"type":"action","fromPageId":"page_1","action":{"id":"action_1","kind":"click"}},
			{"sequence":4,"type":"page","page":{"id":"page_2","fingerprint":"results","url":"https://shop.example/results"}}
		]
	}`)
	if _, _, err := learningtrace.Normalize(input); err == nil || !strings.Contains(err.Error(), "must be action") {
		t.Fatalf("expected order validation, got %v", err)
	}
}

func TestNormalizeAllowsAReusedResultingPage(t *testing.T) {
	input := json.RawMessage(`{
		"schemaVersion":"learning-trace/3",
		"frames":[
			{"sequence":1,"type":"page","page":{"id":"page_1","fingerprint":"home","url":"https://shop.example/"}},
			{"sequence":2,"type":"action","fromPageId":"page_1","action":{"id":"action_1","kind":"fill"}},
			{"sequence":3,"type":"update","actionId":"action_1","fromPageId":"page_1","toPageId":"page_1","update":{"urlChanged":false}},
			{"sequence":4,"type":"page","page":{"id":"page_1","fingerprint":"home","reused":true}}
		]
	}`)
	_, metadata, err := learningtrace.Normalize(input)
	if err != nil {
		t.Fatalf("normalize reused page: %v", err)
	}
	if metadata.FinalURL != "https://shop.example/" {
		t.Fatalf("expected reused page URL, got %#v", metadata)
	}
}
