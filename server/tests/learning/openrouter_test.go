package learning_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"webmcp-automator/server/internal/learning"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestDiscoverUsesOpenRouterStructuredOutputs(t *testing.T) {
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("unexpected authorization header")
		}
		if request.Header.Get("X-OpenRouter-Title") != "WebMCP Automator" {
			t.Fatalf("missing OpenRouter application title")
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body["model"] != "openai/gpt-oss-20b:nitro" {
			t.Fatalf("unexpected model: %#v", body["model"])
		}
		if body["max_tokens"] != float64(8000) {
			t.Fatalf("unexpected output limit: %#v", body["max_tokens"])
		}
		reasoning := body["reasoning"].(map[string]any)
		if reasoning["effort"] != "low" {
			t.Fatalf("expected low reasoning effort: %#v", reasoning)
		}
		format := body["response_format"].(map[string]any)
		jsonSchema := format["json_schema"].(map[string]any)
		if format["type"] != "json_schema" || jsonSchema["strict"] != true {
			t.Fatalf("unexpected structured output config: %#v", format)
		}
		provider := body["provider"].(map[string]any)
		if provider["require_parameters"] != true {
			t.Fatalf("expected provider parameter enforcement: %#v", provider)
		}
		ignored := provider["ignore"].([]any)
		if len(ignored) != 1 || ignored[0] != "groq" {
			t.Fatalf("expected Groq to be excluded for strict discovery: %#v", provider)
		}
		messages := body["messages"].([]any)
		userMessage := messages[1].(map[string]any)["content"].(string)
		if !strings.Contains(userMessage, learning.DiscoveryGoal) {
			t.Fatalf("expected automatic action discovery, got %s", userMessage)
		}
		systemMessage := messages[0].(map[string]any)["content"].(string)
		if !strings.Contains(systemMessage, "Never reproduce a person's name") {
			t.Fatalf("expected privacy stripping instructions")
		}
		bodyText := `{
			"id":"gen_test",
			"model":"openai/gpt-oss-20b:nitro",
			"provider":"fast-provider",
			"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"{\"schemaVersion\":\"action-map/1\",\"site\":{\"origin\":\"https://example.com\",\"observedUrls\":[\"https://example.com/\"]},\"summary\":\"A searchable catalog\",\"states\":[{\"id\":\"catalog\",\"label\":\"Catalog\",\"urlPattern\":\"^https://example.com/\",\"fingerprint\":null,\"evidence\":[\"search form\"]}],\"actions\":[{\"id\":\"search_products\",\"name\":\"Search products\",\"description\":\"Submit a catalog query\",\"category\":\"submit\",\"status\":\"observed\",\"safety\":\"read\",\"confidence\":0.8,\"fromState\":\"catalog\",\"toState\":\"catalog\",\"parameters\":[],\"steps\":[{\"op\":\"wait\",\"target\":{\"css\":null,\"role\":null,\"name\":null,\"placeholder\":null,\"text\":null,\"hrefContains\":null},\"valueFrom\":null,\"literalValue\":null,\"key\":null,\"expect\":{\"kind\":\"none\",\"state\":null,\"urlPattern\":null,\"target\":{\"css\":null,\"role\":null,\"name\":null,\"placeholder\":null,\"text\":null,\"hrefContains\":null}},\"timeoutMs\":100}],\"output\":{\"mode\":\"none\",\"collectionRoot\":{\"css\":null,\"role\":null,\"name\":null,\"placeholder\":null,\"text\":null,\"hrefContains\":null},\"item\":{\"css\":null,\"role\":null,\"name\":null,\"placeholder\":null,\"text\":null,\"hrefContains\":null},\"limit\":10,\"fields\":[]},\"evidence\":[\"recorded\"],\"missingEvidence\":[]}],\"warnings\":[],\"privacy\":{\"redactionsApplied\":0,\"categories\":[],\"policy\":\"No private values retained\"}}"}}]}`
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(bodyText)),
			Request:    request,
		}, nil
	})}

	client := learning.Client{APIKey: "test-key", Endpoint: "https://openrouter.test/chat", HTTPClient: httpClient}
	result, err := client.Discover(context.Background(), json.RawMessage(`{"steps":[]}`))
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if result.ResponseID != "gen_test" ||
		result.Model != "openai/gpt-oss-20b:nitro" ||
		result.Provider != "fast-provider" || result.Finish != "stop" ||
		result.ActionMap.Actions[0].ID != "search_products" {
		t.Fatalf("unexpected result: %#v", result)
	}
}
