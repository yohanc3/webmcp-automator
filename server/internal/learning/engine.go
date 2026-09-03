package learning

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"webmcp-automator/server/internal/actionmap"
)

type MapSnapshot struct {
	Base    MapBase
	Context CompactContext
	Map     actionmap.Map
}

type ContextSource interface {
	Load(context.Context, string) (MapSnapshot, error)
}

type PatchApplication struct {
	Status       string
	ConflictCode string
	Revision     int
}

type PatchSink interface {
	Apply(context.Context, ParseRequest, MaterializedPatch) (PatchApplication, error)
}

type RequestIDFactory func(CompletedLayer, int) string

type Engine struct {
	Parser             Parser
	Profile            ParserProfile
	RequestID          RequestIDFactory
	MaxConflictRetries int
}

type ProcessResult struct {
	Request      ParseRequest
	Materialized MaterializedPatch
	Application  PatchApplication
	ParseCount   int
}

// ProcessLayer always invokes the parser for the supplied completed layer. A
// compare-and-append conflict reloads the exact head/context and reparses the
// same source layer with a new request linked through retryOf.
func (engine Engine) ProcessLayer(ctx context.Context, completed CompletedLayer, source ContextSource, sink PatchSink) (ProcessResult, error) {
	if engine.Parser == nil {
		return ProcessResult{}, errorsNewRejection("PARSER_REQUIRED", "$", "ambient parser is required")
	}
	if source == nil {
		return ProcessResult{}, errorsNewRejection("CONTEXT_SOURCE_REQUIRED", "$", "exact map context source is required")
	}
	if sink == nil {
		return ProcessResult{}, errorsNewRejection("PATCH_SINK_REQUIRED", "$", "patch sink is required")
	}
	profile := engine.Profile
	if profile.ParserID == "" {
		profile = DefaultParserProfile()
	}
	idFactory := engine.RequestID
	if idFactory == nil {
		idFactory = func(layer CompletedLayer, generation int) string {
			return fmt.Sprintf("parse_%s_%06d_%02d", layer.SiteScope.ScopeID, layer.Layer.Sequence, generation)
		}
	}
	maxConflicts := engine.MaxConflictRetries
	if maxConflicts < 1 {
		maxConflicts = 1
	}
	var retryOf *string
	parseCount := 0
	for generation := 0; ; generation++ {
		snapshot, err := source.Load(ctx, completed.SiteScope.ScopeID)
		if err != nil {
			return ProcessResult{}, fmt.Errorf("load exact action-map context: %w", err)
		}
		request, err := AssembleParseRequest(completed, snapshot.Base, snapshot.Context, profile, RequestIdentity{
			RequestID: idFactory(completed, generation), Attempt: 1, RetryOf: retryOf,
		})
		if err != nil {
			return ProcessResult{}, err
		}
		rawPatch, err := engine.Parser.Parse(ctx, request)
		parseCount++
		if err != nil {
			return ProcessResult{Request: request, ParseCount: parseCount}, err
		}
		materialized, err := ValidateAndMaterialize(request, rawPatch, snapshot.Map)
		if err != nil {
			return ProcessResult{Request: request, ParseCount: parseCount}, err
		}
		application, err := sink.Apply(ctx, request, materialized)
		result := ProcessResult{Request: request, Materialized: materialized, Application: application, ParseCount: parseCount}
		if err != nil {
			return result, err
		}
		if application.Status != "conflict" {
			return result, nil
		}
		if generation >= maxConflicts {
			return result, Rejection{Code: "BASE_CONFLICT", Path: "$.mapBase", Message: application.ConflictCode}
		}
		previous := request.RequestID
		retryOf = &previous
	}
}

func errorsNewRejection(code, path, message string) error {
	return Rejection{Code: code, Path: path, Message: message}
}

// FakeParser is deterministic and network-free. Contract fixture patches are
// keyed by requestId; tests and integration can load the frozen X/Orders files
// directly, avoiding a copied fixture or schema inside this package.
type FakeParser struct {
	mu        sync.Mutex
	Responses map[string]json.RawMessage
	requests  []ParseRequest
}

func (parser *FakeParser) Parse(_ context.Context, request ParseRequest) (json.RawMessage, error) {
	parser.mu.Lock()
	defer parser.mu.Unlock()
	parser.requests = append(parser.requests, request)
	response, exists := parser.Responses[request.RequestID]
	if !exists {
		return nil, Rejection{Code: "FAKE_FIXTURE_MISSING", Path: "$.requestId", Message: "no deterministic patch is registered for " + request.RequestID}
	}
	return append(json.RawMessage(nil), response...), nil
}

func (parser *FakeParser) Requests() []ParseRequest {
	parser.mu.Lock()
	defer parser.mu.Unlock()
	return append([]ParseRequest(nil), parser.requests...)
}
