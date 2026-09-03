package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/store"
)

type ambientContextSource struct {
	service store.ActionMapService
	scope   learning.SiteScope
}

func (source ambientContextSource) Load(ctx context.Context, scopeID string) (learning.MapSnapshot, error) {
	head, err := source.service.GetActionMapHead(ctx, scopeID)
	if errors.Is(err, store.ErrActionMapNotFound) {
		return learning.MapSnapshot{
			Base:    learning.MapBase{},
			Context: learning.CompactContext{},
			Map: actionmap.Map{
				SchemaVersion: actionmap.SchemaVersion,
				Site:          actionmap.Site{Origin: source.scope.Origin, ObservedURLs: []string{}},
				States:        []actionmap.State{},
				Actions:       []actionmap.Action{},
				Warnings:      []string{},
			},
		}, nil
	}
	if err != nil {
		return learning.MapSnapshot{}, err
	}
	compact, err := source.service.GetActionMapContext(ctx, scopeID, head.Revision)
	if err != nil {
		return learning.MapSnapshot{}, err
	}
	compactJSON, err := json.Marshal(compact)
	if err != nil {
		return learning.MapSnapshot{}, err
	}
	var context learning.CompactContext
	if err := json.Unmarshal(compactJSON, &context); err != nil {
		return learning.MapSnapshot{}, err
	}
	return learning.MapSnapshot{
		Base:    learning.MapBase{Revision: head.Revision, Digest: head.Digest, PreviousLayerSequence: head.SourceLayerSequence},
		Context: context,
		Map:     head.ActionMap,
	}, nil
}

type ambientPatchSink struct{ service store.ActionMapService }

func (sink ambientPatchSink) Apply(ctx context.Context, request learning.ParseRequest, materialized learning.MaterializedPatch) (learning.PatchApplication, error) {
	requestJSON, err := json.Marshal(request)
	if err != nil {
		return learning.PatchApplication{}, err
	}
	patchJSON, err := json.Marshal(materialized.Patch)
	if err != nil {
		return learning.PatchApplication{}, err
	}
	var input store.ApplyActionMapRequest
	if err := json.Unmarshal([]byte(`{"request":`+string(requestJSON)+`,"patch":`+string(patchJSON)+`}`), &input); err != nil {
		return learning.PatchApplication{}, err
	}
	receipt, err := sink.service.ApplyActionMapPatch(ctx, input)
	if err != nil {
		return learning.PatchApplication{}, err
	}
	return learning.PatchApplication{Status: receipt.Application.Status, ConflictCode: valueOrEmpty(receipt.Application.ConflictCode)}, nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (server *Server) processAmbientLayer(writer http.ResponseWriter, request *http.Request) {
	if server.ambient == nil || server.actionMaps == nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "ambient learning is not configured"})
		return
	}
	var layer learning.CompletedLayer
	if err := readJSON(writer, request, &layer); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"outcome": "rejected", "error": err.Error()})
		return
	}
	result, err := server.ambient.ProcessLayer(request.Context(), layer, ambientContextSource{service: server.actionMaps, scope: layer.SiteScope}, ambientPatchSink{server.actionMaps})
	if err != nil {
		writeAmbientError(writer, err, result)
		return
	}
	status := http.StatusOK
	if result.Application.Status == "conflict" {
		status = http.StatusConflict
	}
	if result.Application.Status == "rejected" {
		writeJSON(writer, http.StatusUnprocessableEntity, map[string]any{"outcome": "rejected", "requestId": result.Request.RequestID, "retryOf": result.Request.RetryOf, "parseCount": result.ParseCount})
		return
	}
	var candidateRevision any
	if result.Application.Status == "applied" {
		head, headErr := server.actionMaps.GetActionMapHead(request.Context(), layer.SiteScope.ScopeID)
		if headErr != nil {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"outcome": "retryable", "retryable": true, "error": "accepted action map could not be loaded for review projection"})
			return
		}
		digest := ""
		if head.Digest != nil {
			digest = *head.Digest
		}
		candidate, compileErr := learning.CompileAmbientCandidate(layer.SiteScope.ScopeID, head.ActionMap, head.Revision, digest, time.Now().UTC())
		if compileErr != nil {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"outcome": "retryable", "retryable": true, "error": "accepted action map could not be projected for review"})
			return
		}
		stored, storeErr := server.store.InsertActionListRevision(request.Context(), candidate)
		if storeErr != nil {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"outcome": "retryable", "retryable": true, "error": "accepted action map review projection is temporarily unavailable"})
			return
		}
		candidateRevision = map[string]any{"listId": stored.ListID, "revision": stored.Revision, "digest": stored.Digest, "status": stored.Status}
	}
	writeJSON(writer, status, map[string]any{
		"outcome":             result.Application.Status,
		"requestId":           result.Request.RequestID,
		"retryOf":             result.Request.RetryOf,
		"parseCount":          result.ParseCount,
		"actionListCandidate": candidateRevision,
	})
}

func writeAmbientError(writer http.ResponseWriter, err error, result learning.ProcessResult) {
	var rejection learning.Rejection
	if errors.As(err, &rejection) {
		if rejection.Code == "BASE_CONFLICT" {
			writeJSON(writer, http.StatusConflict, map[string]any{"outcome": "conflict", "retryable": true, "error": rejection, "requestId": result.Request.RequestID, "retryOf": result.Request.RetryOf, "parseCount": result.ParseCount})
			return
		}
		writeJSON(writer, http.StatusUnprocessableEntity, map[string]any{"outcome": "rejected", "error": rejection, "requestId": result.Request.RequestID, "parseCount": result.ParseCount})
		return
	}
	// Provider transport, rate-limit, and internal errors are operational
	// failures. They are intentionally retryable rather than parser rejection.
	message := err.Error()
	status := http.StatusServiceUnavailable
	if strings.Contains(message, "429") {
		status = http.StatusTooManyRequests
	}
	writeJSON(writer, status, map[string]any{"outcome": "retryable", "retryable": true, "error": "ambient parser temporarily unavailable", "requestId": result.Request.RequestID, "parseCount": result.ParseCount})
}
