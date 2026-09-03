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

func TestNormalizeRejectsNonChronologicalActionTimes(t *testing.T) {
	input := json.RawMessage(`{
		"schemaVersion":"learning-trace/3","startedAt":"2026-09-03T12:00:00Z","stoppedAt":"2026-09-03T12:01:00Z",
		"frames":[
			{"sequence":1,"type":"page","page":{"id":"page_1","fingerprint":"one","url":"https://shop.example/"}},
			{"sequence":2,"type":"action","fromPageId":"page_1","action":{"id":"action_1","kind":"click","occurredAt":"2026-09-03T12:00:30Z"}},
			{"sequence":3,"type":"update","actionId":"action_1","fromPageId":"page_1","toPageId":"page_2","update":{}},
			{"sequence":4,"type":"page","page":{"id":"page_2","fingerprint":"two","url":"https://shop.example/two"}},
			{"sequence":5,"type":"action","fromPageId":"page_2","action":{"id":"action_2","kind":"click","occurredAt":"2026-09-03T12:00:20Z"}},
			{"sequence":6,"type":"update","actionId":"action_2","fromPageId":"page_2","toPageId":"page_3","update":{}},
			{"sequence":7,"type":"page","page":{"id":"page_3","fingerprint":"three","url":"https://shop.example/three"}}
		]
	}`)
	if _, _, err := learningtrace.Normalize(input); err == nil || !strings.Contains(err.Error(), "not chronological") {
		t.Fatalf("expected timestamp chronology rejection, got %v", err)
	}
}

func TestNormalizeRejectsUnknownFieldsWithAPath(t *testing.T) {
	input := json.RawMessage(`{
		"schemaVersion":"learning-trace/3","frames":[
			{"sequence":1,"type":"page","page":{"id":"page_1","fingerprint":"one","url":"https://shop.example/","rawDom":"secret"}},
			{"sequence":2,"type":"action","fromPageId":"page_1","action":{"id":"action_1","kind":"click"}},
			{"sequence":3,"type":"update","actionId":"action_1","fromPageId":"page_1","toPageId":"page_2","update":{}},
			{"sequence":4,"type":"page","page":{"id":"page_2","fingerprint":"two","url":"https://shop.example/two"}}
		]
	}`)
	if _, _, err := learningtrace.Normalize(input); err == nil || !strings.Contains(err.Error(), "$.frames[0].page.rawDom") {
		t.Fatalf("expected field-addressed unknown field rejection, got %v", err)
	}
}
