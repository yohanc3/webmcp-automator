package learning

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"webmcp-automator/server/internal/actionmap"
)

const (
	CerebrasProvider   = "cerebras"
	OpenRouterProvider = "openrouter"
	CerebrasModel      = "gemma-4-31b"
	OpenRouterModel    = "google/gemma-4-31b-it"

	cerebrasURL   = "https://api.cerebras.ai/v1/chat/completions"
	openRouterURL = "https://openrouter.ai/api/v1/chat/completions"
	// DiscoveryGoal is retained temporarily for the integration-owned legacy
	// route and store interfaces. It is never sent to an AI provider.
	DiscoveryGoal = "Discover the website states, available actions, and deterministic steps supported by this recording."
)

type Client struct {
	apiKey     string
	provider   string
	model      string
	HTTPClient *http.Client
	Endpoint   string
	// PatchSchema is the frozen action-map-patch/1 schema supplied by the
	// integration layer. Keeping the contract file authoritative avoids a
	// second, drifting schema copy in this package.
	PatchSchema json.RawMessage
}

type Configuration struct {
	APIKeyConfigured bool
	Provider         string
	Model            string
}

func NewClient(cerebrasAPIKey string, openRouterAPIKey string) Client {
	if apiKey := strings.TrimSpace(cerebrasAPIKey); apiKey != "" {
		return Client{
			apiKey: apiKey, provider: CerebrasProvider, model: CerebrasModel,
		}
	}
	if apiKey := strings.TrimSpace(openRouterAPIKey); apiKey != "" {
		return Client{
			apiKey: apiKey, provider: OpenRouterProvider, model: OpenRouterModel,
		}
	}
	return Client{}
}

func (client Client) Configuration() Configuration {
	provider := client.provider
	if provider == "" {
		provider = "none"
	}
	return Configuration{
		APIKeyConfigured: client.apiKey != "",
		Provider:         provider,
		Model:            client.model,
	}
}

type Result struct {
	ActionMap      actionmap.Map   `json:"actionMap"`
	Model          string          `json:"model"`
	ResponseID     string          `json:"responseId"`
	Provider       string          `json:"provider,omitempty"`
	Finish         string          `json:"finishReason,omitempty"`
	Usage          json.RawMessage `json:"usage,omitempty"`
	PromptVersion  string          `json:"promptVersion,omitempty"`
	ResponseDigest string          `json:"responseDigest,omitempty"`
}

type chatEnvelope struct {
	ID       string          `json:"id"`
	Model    string          `json:"model"`
	Provider string          `json:"provider"`
	Choices  []chatChoice    `json:"choices"`
	Usage    json.RawMessage `json:"usage"`
	Error    *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type chatChoice struct {
	FinishReason string `json:"finish_reason"`
	Message      struct {
		Content          string            `json:"content"`
		Reasoning        string            `json:"reasoning"`
		ReasoningDetails []json.RawMessage `json:"reasoning_details"`
	} `json:"message"`
}

func (client Client) Discover(_ context.Context, _ json.RawMessage) (Result, error) {
	return Result{}, Rejection{
		Code: "LEGACY_DISCOVERY_REMOVED", Path: "$",
		Message: "whole-trace discovery was replaced by one ambient parse per CompletedLayer",
	}
}

func providerEndpoint(provider string) string {
	switch provider {
	case CerebrasProvider:
		return cerebrasURL
	case OpenRouterProvider:
		return openRouterURL
	default:
		return ""
	}
}

func providerSchema(provider string, schema any) any {
	if provider != CerebrasProvider {
		return schema
	}
	// Cerebras strict schemas exclude regex patterns and array-size constraints.
	// The returned action map still passes through the server's Go validator.
	stripUnsupportedCerebrasSchemaKeywords(schema)
	return schema
}

func stripUnsupportedCerebrasSchemaKeywords(value any) {
	switch typed := value.(type) {
	case map[string]any:
		delete(typed, "pattern")
		delete(typed, "minItems")
		delete(typed, "maxItems")
		for _, child := range typed {
			stripUnsupportedCerebrasSchemaKeywords(child)
		}
	case []any:
		for _, child := range typed {
			stripUnsupportedCerebrasSchemaKeywords(child)
		}
	}
}
