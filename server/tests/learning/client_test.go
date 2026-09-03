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

const actionMapJSON = `{
	"schemaVersion":"action-map/1",
	"site":{"origin":"https://example.com","observedUrls":["https://example.com/"]},
	"summary":"A searchable catalog",
	"states":[{"id":"catalog","label":"Catalog","urlPattern":"^https://example.com/","fingerprint":null,"evidence":["search form"]}],
	"actions":[{
		"id":"search_products","name":"Search products","description":"Submit a catalog query",
		"category":"submit","status":"observed","safety":"read","confidence":0.8,
		"fromState":"catalog","toState":"catalog","parameters":[],
		"steps":[{"op":"wait","target":{"css":null,"role":null,"name":null,"placeholder":null,"text":null,"hrefContains":null},"valueFrom":null,"literalValue":null,"key":null,"expect":{"kind":"none","state":null,"urlPattern":null,"target":{"css":null,"role":null,"name":null,"placeholder":null,"text":null,"hrefContains":null}},"timeoutMs":100}],
		"output":{"mode":"none","collectionRoot":{"css":null,"role":null,"name":null,"placeholder":null,"text":null,"hrefContains":null},"item":{"css":null,"role":null,"name":null,"placeholder":null,"text":null,"hrefContains":null},"limit":10,"fields":[]},
		"evidence":["recorded"],"missingEvidence":[]
	}],
	"warnings":[],
	"privacy":{"redactionsApplied":0,"categories":[],"policy":"No private values retained"}
}`

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestNewClientSelectsAvailableProvider(t *testing.T) {
	tests := []struct {
		name          string
		cerebrasKey   string
		openRouterKey string
		configured    bool
		provider      string
		model         string
	}{
		{
			name:        "Cerebras takes precedence when both keys exist",
			cerebrasKey: "cerebras-key", openRouterKey: "openrouter-key",
			configured: true, provider: learning.CerebrasProvider, model: learning.CerebrasModel,
		},
		{
			name: "Cerebras is selected alone", cerebrasKey: "cerebras-key",
			configured: true, provider: learning.CerebrasProvider, model: learning.CerebrasModel,
		},
		{
			name: "OpenRouter is the fallback", openRouterKey: "openrouter-key",
			configured: true, provider: learning.OpenRouterProvider, model: learning.OpenRouterModel,
		},
		{name: "No key leaves synthesis disabled", provider: "none"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := learning.NewClient(test.cerebrasKey, test.openRouterKey)
			configuration := client.Configuration()
			if configuration.APIKeyConfigured != test.configured ||
				configuration.Provider != test.provider || configuration.Model != test.model {
				t.Fatalf("unexpected configuration: %#v", configuration)
			}
		})
	}
}

func TestDiscoverUsesOpenRouterGemmaStructuredOutputs(t *testing.T) {
	client := learning.NewClient("", "test-key")
	client.Endpoint = "https://openrouter.test/chat"
	client.HTTPClient = requestClient(t, func(request *http.Request, body map[string]any) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatal("unexpected authorization header")
		}
		if request.Header.Get("X-OpenRouter-Title") != "WebMCP Automator" {
			t.Fatal("missing OpenRouter application title")
		}
		if body["model"] != learning.OpenRouterModel {
			t.Fatalf("unexpected model: %#v", body["model"])
		}
		assertSharedRequest(t, body)
		reasoning := body["reasoning"].(map[string]any)
		if reasoning["effort"] != "low" {
			t.Fatalf("expected low reasoning effort: %#v", reasoning)
		}
		provider := body["provider"].(map[string]any)
		if provider["require_parameters"] != true {
			t.Fatalf("expected provider parameter enforcement: %#v", provider)
		}
		schema := responseSchema(body)
		if !hasSchemaKeyword(schema, "pattern") || !hasSchemaKeyword(schema, "maxItems") {
			t.Fatal("OpenRouter should receive the complete action-map schema")
		}
	}, learning.OpenRouterModel, "fast-provider")

	result, err := client.Discover(context.Background(), json.RawMessage(`{"steps":[]}`))
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if result.ResponseID != "gen_test" || result.Model != learning.OpenRouterModel ||
		result.Provider != "fast-provider" || result.Finish != "stop" ||
		result.ActionMap.Actions[0].ID != "search_products" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestDiscoverUsesCerebrasGemmaStructuredOutputs(t *testing.T) {
	client := learning.NewClient("test-key", "")
	client.Endpoint = "https://cerebras.test/chat"
	client.HTTPClient = requestClient(t, func(request *http.Request, body map[string]any) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatal("unexpected authorization header")
		}
		if request.Header.Get("X-OpenRouter-Title") != "" || request.Header.Get("HTTP-Referer") != "" {
			t.Fatal("Cerebras request included OpenRouter-only headers")
		}
		if body["model"] != learning.CerebrasModel {
			t.Fatalf("unexpected model: %#v", body["model"])
		}
		assertSharedRequest(t, body)
		if _, exists := body["reasoning"]; exists {
			t.Fatal("Cerebras request included the OpenRouter reasoning parameter")
		}
		if _, exists := body["provider"]; exists {
			t.Fatal("Cerebras request included OpenRouter provider routing")
		}
		schema := responseSchema(body)
		if hasSchemaKeyword(schema, "pattern") || hasSchemaKeyword(schema, "minItems") ||
			hasSchemaKeyword(schema, "maxItems") {
			t.Fatal("Cerebras request included unsupported strict-schema keywords")
		}
		encodedSchema, err := json.Marshal(schema)
		if err != nil {
			t.Fatalf("encode Cerebras schema: %v", err)
		}
		if len(encodedSchema) > 5000 {
			t.Fatalf("Cerebras schema exceeds 5,000 characters: %d", len(encodedSchema))
		}
	}, learning.CerebrasModel, "")

	result, err := client.Discover(context.Background(), json.RawMessage(`{"steps":[]}`))
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if result.ResponseID != "gen_test" || result.Model != learning.CerebrasModel ||
		result.Provider != learning.CerebrasProvider || result.Finish != "stop" ||
		result.ActionMap.Actions[0].ID != "search_products" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func requestClient(
	t *testing.T,
	assertRequest func(*http.Request, map[string]any),
	model string,
	provider string,
) *http.Client {
	t.Helper()
	return &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		assertRequest(request, body)
		responseBody, err := json.Marshal(map[string]any{
			"id": "gen_test", "model": model, "provider": provider,
			"choices": []map[string]any{{
				"finish_reason": "stop",
				"message":       map[string]any{"role": "assistant", "content": actionMapJSON},
			}},
		})
		if err != nil {
			t.Fatalf("encode response: %v", err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(string(responseBody))),
			Request:    request,
		}, nil
	})}
}

func assertSharedRequest(t *testing.T, body map[string]any) {
	t.Helper()
	if body["max_completion_tokens"] != float64(8000) {
		t.Fatalf("unexpected output limit: %#v", body["max_completion_tokens"])
	}
	format := body["response_format"].(map[string]any)
	jsonSchema := format["json_schema"].(map[string]any)
	if format["type"] != "json_schema" || jsonSchema["strict"] != true {
		t.Fatalf("unexpected structured output config: %#v", format)
	}
	messages := body["messages"].([]any)
	userMessage := messages[1].(map[string]any)["content"].(string)
	if !strings.Contains(userMessage, learning.DiscoveryGoal) {
		t.Fatalf("expected automatic action discovery, got %s", userMessage)
	}
	systemMessage := messages[0].(map[string]any)["content"].(string)
	if !strings.Contains(systemMessage, "Never reproduce a person's name") {
		t.Fatal("expected privacy stripping instructions")
	}
}

func responseSchema(body map[string]any) any {
	format := body["response_format"].(map[string]any)
	jsonSchema := format["json_schema"].(map[string]any)
	return jsonSchema["schema"]
}

func hasSchemaKeyword(value any, keyword string) bool {
	switch typed := value.(type) {
	case map[string]any:
		if _, exists := typed[keyword]; exists {
			return true
		}
		for _, child := range typed {
			if hasSchemaKeyword(child, keyword) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if hasSchemaKeyword(child, keyword) {
				return true
			}
		}
	}
	return false
}
