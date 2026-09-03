package learning_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"webmcp-automator/server/internal/learning"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestWholeTraceProviderPathIsRemoved(t *testing.T) {
	client := learning.NewClient("", "test-key")
	_, err := client.Discover(context.Background(), json.RawMessage(`{"schemaVersion":"learning-trace/3"}`))
	var rejection learning.Rejection
	if !errors.As(err, &rejection) || rejection.Code != "LEGACY_DISCOVERY_REMOVED" {
		t.Fatalf("legacy discovery was not retired: %v", err)
	}
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
