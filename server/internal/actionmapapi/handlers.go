package actionmapapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"webmcp-automator/server/internal/store"
)

type Handlers struct {
	service store.ActionMapService
}

func New(service store.ActionMapService) *Handlers {
	return &Handlers{service: service}
}

// Head is composable with: GET /v1/action-maps/{scopeId}/head.
func (handlers *Handlers) Head(writer http.ResponseWriter, request *http.Request) {
	scopeID := strings.TrimSpace(request.PathValue("scopeId"))
	if scopeID == "" {
		writeError(writer, http.StatusBadRequest, "scopeId is required")
		return
	}
	snapshot, err := handlers.service.GetActionMapHead(request.Context(), scopeID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	setDigestHeader(writer, snapshot.Digest)
	writeJSON(writer, http.StatusOK, snapshot)
}

// Context is composable with: GET /v1/action-maps/{scopeId}/context.
func (handlers *Handlers) Context(writer http.ResponseWriter, request *http.Request) {
	scopeID := strings.TrimSpace(request.PathValue("scopeId"))
	revision, err := nonNegativeRevision(request.URL.Query().Get("revision"))
	if scopeID == "" || err != nil {
		writeError(writer, http.StatusBadRequest, "scopeId and a non-negative revision are required")
		return
	}
	context, err := handlers.service.GetActionMapContext(request.Context(), scopeID, revision)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	setDigestHeader(writer, context.Digest)
	writeJSON(writer, http.StatusOK, context)
}

// ApplyPatch is composable with: POST /v1/action-maps/{scopeId}/patches.
func (handlers *Handlers) ApplyPatch(writer http.ResponseWriter, request *http.Request) {
	defer request.Body.Close()
	var input store.ApplyActionMapRequest
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"outcome": "rejected", "error": "request and patch must be strict JSON"})
		return
	}
	if err := requireEOF(decoder); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"outcome": "rejected", "error": "request body must contain one JSON value"})
		return
	}
	scopeID := strings.TrimSpace(request.PathValue("scopeId"))
	if scopeID == "" || scopeID != input.Request.SiteScope.ScopeID || scopeID != input.Patch.SiteScopeID {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"outcome": "rejected", "error": "path scopeId must match request and patch"})
		return
	}
	receipt, err := handlers.service.ApplyActionMapPatch(request.Context(), input)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	status := http.StatusOK
	switch receipt.Application.Status {
	case "applied":
		status = http.StatusCreated
	case "conflict":
		status = http.StatusConflict
	case "rejected":
		status = http.StatusUnprocessableEntity
	}
	if receipt.Application.Result != nil {
		setDigestHeader(writer, receipt.Application.Result.Digest)
	}
	writeJSON(writer, status, receipt)
}

// Revision is composable with: GET /v1/action-maps/{scopeId}/revisions/{revision}.
func (handlers *Handlers) Revision(writer http.ResponseWriter, request *http.Request) {
	scopeID := strings.TrimSpace(request.PathValue("scopeId"))
	revision, err := positiveRevision(request.PathValue("revision"))
	if scopeID == "" || err != nil {
		writeError(writer, http.StatusBadRequest, "scopeId and a positive revision are required")
		return
	}
	snapshot, err := handlers.service.GetActionMapRevision(request.Context(), scopeID, revision)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	setDigestHeader(writer, snapshot.Digest)
	writeJSON(writer, http.StatusOK, snapshot)
}

func positiveRevision(value string) (int, error) {
	revision, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || revision < 1 {
		return 0, errors.New("revision must be positive")
	}
	return revision, nil
}

func nonNegativeRevision(value string) (int, error) {
	revision, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || revision < 0 {
		return 0, errors.New("revision must be non-negative")
	}
	return revision, nil
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func writeServiceError(writer http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrActionMapNotFound) {
		writeError(writer, http.StatusNotFound, err.Error())
		return
	}
	writeError(writer, http.StatusInternalServerError, "action map service failed")
}

func setDigestHeader(writer http.ResponseWriter, digest *string) {
	if digest != nil {
		writer.Header().Set("ETag", `"`+*digest+`"`)
	}
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
