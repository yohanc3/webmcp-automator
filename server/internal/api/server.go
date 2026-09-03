package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/actionmapapi"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/privacy"
	"webmcp-automator/server/internal/store"
	learningtrace "webmcp-automator/server/internal/trace"
)

const maxRequestBytes = 8 << 20

type Discoverer interface {
	Discover(context.Context, json.RawMessage) (learning.Result, error)
}

type DiscoveryStore interface {
	CreateSession(context.Context, string, string, string, json.RawMessage) (store.Session, error)
	MarkLearning(context.Context, string) error
	MarkFailed(context.Context, string, error) error
	GetSession(context.Context, string) (store.Session, error)
	SaveDiscovery(context.Context, string, learning.Result) (store.Discovery, error)
	GetDiscovery(context.Context, string) (store.Discovery, error)
	ListActive(context.Context, string) ([]store.PublishedAdapter, error)
	Publish(context.Context, string, string) error
	RecordRun(context.Context, store.Run) error
	InsertActionListRevision(context.Context, json.RawMessage) (store.ActionListRevision, error)
	DiscoverActionLists(context.Context, string, string) ([]store.ActionListRevision, error)
	GetActionListRevision(context.Context, string, int) (store.ActionListRevision, error)
	PublishActionList(context.Context, string, int, store.PublishActionListRequest) (store.ActionListRevision, error)
	RecordRunObservation(context.Context, store.RunObservation) error
}

type Server struct {
	store            DiscoveryStore
	discoverer       Discoverer
	apiKeyConfigured bool
	provider         string
	model            string
	demoDirectory    string
	handler          http.Handler
	actionMaps       store.ActionMapService
	ambient          *learning.Engine
}

type learnRequest struct {
	Trace json.RawMessage `json:"trace"`
}

type legacyPublishRequest struct {
	AdapterID string `json:"adapterId"`
	VersionID string `json:"versionId"`
}

func New(
	database DiscoveryStore,
	discoverer Discoverer,
	apiKeyConfigured bool,
	provider string,
	model string,
	demoDirectory string,
) *Server {
	server := &Server{
		store: database, discoverer: discoverer, apiKeyConfigured: apiKeyConfigured,
		provider: provider, model: model, demoDirectory: demoDirectory,
	}
	if actionMaps, ok := database.(store.ActionMapService); ok {
		server.actionMaps = actionMaps
		if parser, ok := discoverer.(learning.Parser); ok {
			server.ambient = &learning.Engine{Parser: parser, Profile: learning.DefaultParserProfile(), MaxConflictRetries: 1}
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", server.health)
	mux.HandleFunc("GET /api/adapters", server.listAdapters)
	mux.HandleFunc("POST /api/adapters/publish", server.publish)
	mux.HandleFunc("POST /api/runs", server.recordRun)
	mux.HandleFunc("POST /v1/action-lists", server.insertActionList)
	mux.HandleFunc("GET /v1/action-lists", server.discoverActionLists)
	mux.HandleFunc("GET /v1/action-lists/{listID}/revisions/{revision}", server.getActionListRevision)
	mux.HandleFunc("POST /v1/action-lists/{listID}/revisions/{revision}/publish", server.publishActionList)
	mux.HandleFunc("POST /v1/run-observations", server.recordRunObservation)
	if server.actionMaps != nil {
		actionMapHandlers := actionmapapi.New(server.actionMaps)
		mux.HandleFunc("GET /v1/action-maps/{scopeId}/head", actionMapHandlers.Head)
		mux.HandleFunc("GET /v1/action-maps/{scopeId}/context", actionMapHandlers.Context)
		mux.HandleFunc("GET /v1/action-maps/{scopeId}/revisions/{revision}", actionMapHandlers.Revision)
		mux.HandleFunc("POST /v1/action-maps/{scopeId}/patches", server.requireExtensionBoundary(actionMapHandlers.ApplyPatch))
		mux.HandleFunc("POST /v1/ambient/layers", server.requireExtensionBoundary(server.processAmbientLayer))
	}
	mux.HandleFunc("GET /demo", server.demo)
	mux.HandleFunc("GET /demo/", server.demo)
	server.handler = server.withCORS(mux)
	return server
}

func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	server.handler.ServeHTTP(writer, request)
}

func (server *Server) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok": true, "model": server.model, "apiKeyConfigured": server.apiKeyConfigured,
		"provider": server.provider, "database": "postgres",
	})
}

func (server *Server) discover(writer http.ResponseWriter, request *http.Request) {
	var input learnRequest
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	normalizedTrace, _, err := learningtrace.Normalize(input.Trace)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	sanitizedTrace, privacySummary, err := privacy.SanitizeTrace(normalizedTrace)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	sanitizedTrace, metadata, err := learningtrace.Normalize(sanitizedTrace)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	session, err := server.store.CreateSession(
		request.Context(), learning.DiscoveryGoal,
		metadata.StartURL, metadata.FinalURL, sanitizedTrace,
	)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := server.store.MarkLearning(request.Context(), session.ID); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	go server.runDiscovery(session.ID, sanitizedTrace, privacySummary)
	writeJSON(writer, http.StatusAccepted, map[string]any{
		"sessionId": session.ID,
		"status":    "learning",
		"privacy":   privacySummary,
	})
}

func (server *Server) runDiscovery(
	sessionID string,
	sanitizedTrace json.RawMessage,
	privacySummary privacy.Summary,
) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	result, err := server.discoverer.Discover(ctx, sanitizedTrace)
	if err != nil {
		server.markDiscoveryFailed(sessionID, err)
		return
	}
	result.ActionMap.Privacy = actionmap.Privacy{
		RedactionsApplied: privacySummary.RedactionsApplied,
		Categories:        privacySummary.Categories,
		Policy:            "Sensitive values were scrubbed before storage and model transmission.",
	}
	persistContext, persistCancel := context.WithTimeout(context.Background(), 10*time.Second)
	_, err = server.store.SaveDiscovery(persistContext, sessionID, result)
	persistCancel()
	if err != nil {
		server.markDiscoveryFailed(sessionID, err)
	}
}

func (server *Server) markDiscoveryFailed(sessionID string, cause error) {
	persistContext, persistCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer persistCancel()
	_ = server.store.MarkFailed(persistContext, sessionID, cause)
}

func (server *Server) discoveryStatus(writer http.ResponseWriter, request *http.Request) {
	sessionID := strings.TrimSpace(request.PathValue("sessionID"))
	session, err := server.store.GetSession(request.Context(), sessionID)
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	body := map[string]any{
		"sessionId":  session.ID,
		"status":     session.Status,
		"model":      session.Model,
		"responseId": session.ResponseID,
	}
	if session.Error != nil {
		body["error"] = *session.Error
	}
	if session.Status == "candidate" {
		discovery, err := server.store.GetDiscovery(request.Context(), session.ID)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		body["discovery"] = discovery
		body["privacy"] = discovery.ActionMap.Privacy
	}
	writeJSON(writer, http.StatusOK, body)
}

func (server *Server) listAdapters(writer http.ResponseWriter, request *http.Request) {
	origin := strings.TrimSpace(request.URL.Query().Get("origin"))
	if origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "origin must be an HTTP or HTTPS origin"})
			return
		}
		origin = parsed.Scheme + "://" + parsed.Host
	}
	adapters, err := server.store.ListActive(request.Context(), origin)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"adapters": adapters})
}

func (server *Server) publish(writer http.ResponseWriter, request *http.Request) {
	var input legacyPublishRequest
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if input.AdapterID == "" || input.VersionID == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "adapterId and versionId are required"})
		return
	}
	if err := server.store.Publish(request.Context(), input.AdapterID, input.VersionID); err != nil {
		status := http.StatusNotFound
		if errors.Is(err, store.ErrGate) {
			status = http.StatusConflict
		}
		writeJSON(writer, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"published": true})
}

func (server *Server) insertActionList(writer http.ResponseWriter, request *http.Request) {
	raw, err := readRawJSON(writer, request)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	revision, err := server.store.InsertActionListRevision(request.Context(), raw)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	setRegistryHeaders(writer, revision.Digest)
	writeJSON(writer, http.StatusCreated, revision)
}

func (server *Server) discoverActionLists(writer http.ResponseWriter, request *http.Request) {
	origin := strings.TrimSpace(request.URL.Query().Get("origin"))
	absoluteURL := strings.TrimSpace(request.URL.Query().Get("url"))
	if origin == "" || absoluteURL == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "origin and url are required"})
		return
	}
	revisions, err := server.store.DiscoverActionLists(request.Context(), origin, absoluteURL)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	lists := make([]json.RawMessage, 0, len(revisions))
	for _, revision := range revisions {
		lists = append(lists, revision.Document)
	}
	body := struct {
		ActionLists []json.RawMessage `json:"actionLists"`
	}{ActionLists: lists}
	encoded, err := json.Marshal(body)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256(encoded))
	setRegistryHeaders(writer, digest)
	if requestETagMatches(request, digest) {
		writer.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(writer, http.StatusOK, body)
}

func (server *Server) getActionListRevision(writer http.ResponseWriter, request *http.Request) {
	revisionNumber, err := positiveRevision(request.PathValue("revision"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	revision, err := server.store.GetActionListRevision(
		request.Context(), strings.TrimSpace(request.PathValue("listID")), revisionNumber,
	)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	setRegistryHeaders(writer, revision.Digest)
	if requestETagMatches(request, revision.Digest) {
		writer.WriteHeader(http.StatusNotModified)
		return
	}
	writeRawJSON(writer, http.StatusOK, revision.Document)
}

func (server *Server) publishActionList(writer http.ResponseWriter, request *http.Request) {
	revisionNumber, err := positiveRevision(request.PathValue("revision"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var input store.PublishActionListRequest
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	revision, err := server.store.PublishActionList(
		request.Context(), strings.TrimSpace(request.PathValue("listID")), revisionNumber, input,
	)
	if err != nil {
		writeRegistryError(writer, err)
		return
	}
	setRegistryHeaders(writer, revision.Digest)
	writeJSON(writer, http.StatusOK, revision)
}

func (server *Server) recordRunObservation(writer http.ResponseWriter, request *http.Request) {
	var observation store.RunObservation
	if err := readJSON(writer, request, &observation); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := server.store.RecordRunObservation(request.Context(), observation); err != nil {
		writeRegistryError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]bool{"recorded": true})
}

func (server *Server) recordRun(writer http.ResponseWriter, request *http.Request) {
	var input store.Run
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if input.VersionID == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "versionId is required"})
		return
	}
	if err := server.store.RecordRun(request.Context(), input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]bool{"recorded": true})
}

func (server *Server) demo(writer http.ResponseWriter, request *http.Request) {
	if server.demoDirectory == "" {
		http.NotFound(writer, request)
		return
	}
	cleanPath := strings.TrimPrefix(request.URL.Path, "/demo")
	if cleanPath == "" || cleanPath == "/" {
		cleanPath = "/index.html"
	}
	filePath := filepath.Join(server.demoDirectory, filepath.Clean(cleanPath))
	root, _ := filepath.Abs(server.demoDirectory)
	resolved, _ := filepath.Abs(filePath)
	if !strings.HasPrefix(resolved, root+string(os.PathSeparator)) {
		http.NotFound(writer, request)
		return
	}
	if info, err := os.Stat(resolved); err == nil && !info.IsDir() {
		http.ServeFile(writer, request, resolved)
		return
	}
	if filepath.Ext(cleanPath) != "" {
		http.NotFound(writer, request)
		return
	}
	http.ServeFile(writer, request, filepath.Join(root, "index.html"))
}

func (server *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if isAmbientMutation(request) {
			if extensionOrigin(origin) {
				writer.Header().Set("Access-Control-Allow-Origin", origin)
				writer.Header().Set("Vary", "Origin")
			}
			writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, If-None-Match, X-WebMCP-Internal")
		} else {
			writer.Header().Set("Access-Control-Allow-Origin", "*")
			writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, If-None-Match")
		}
		writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		writer.Header().Set("Access-Control-Expose-Headers", "ETag, X-Content-Digest")
		writer.Header().Set("Cache-Control", "no-store")
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

// requireExtensionBoundary is deliberately checked before JSON decoding. Local
// host binding and permissive CORS do not stop a normal webpage from issuing a
// POST, so mutation routes require Chrome's extension-only origin plus an
// internal extension header. Tests and non-browser callers can provide both
// values explicitly without a hidden global dependency.
func (server *Server) requireExtensionBoundary(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if !extensionOrigin(request.Header.Get("Origin")) || request.Header.Get("X-WebMCP-Internal") != "ambient-v1" {
			writeJSON(writer, http.StatusForbidden, map[string]any{"outcome": "rejected", "error": "ambient mutation requires a Chrome extension boundary"})
			return
		}
		next(writer, request)
	}
}

func isAmbientMutation(request *http.Request) bool {
	return request.Method == http.MethodPost && (request.URL.Path == "/v1/ambient/layers" || strings.HasPrefix(request.URL.Path, "/v1/action-maps/"))
}

func extensionOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Scheme == "chrome-extension" && parsed.Host != ""
}

func readJSON(writer http.ResponseWriter, request *http.Request, destination any) error {
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("request body must be valid JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func readRawJSON(writer http.ResponseWriter, request *http.Request) (json.RawMessage, error) {
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	if !json.Valid(raw) {
		return nil, errors.New("request body must be valid JSON")
	}
	return json.RawMessage(raw), nil
}

func positiveRevision(value string) (int, error) {
	revision, err := strconv.Atoi(value)
	if err != nil || revision < 1 {
		return 0, errors.New("revision must be a positive integer")
	}
	return revision, nil
}

func writeRegistryError(writer http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, store.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, store.ErrConflict), errors.Is(err, store.ErrGate):
		status = http.StatusConflict
	}
	writeJSON(writer, status, map[string]string{"error": err.Error()})
}

func setRegistryHeaders(writer http.ResponseWriter, digest string) {
	writer.Header().Set("ETag", `"`+digest+`"`)
	writer.Header().Set("X-Content-Digest", digest)
	writer.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
}

func requestETagMatches(request *http.Request, digest string) bool {
	wanted := `"` + digest + `"`
	for _, value := range strings.Split(request.Header.Get("If-None-Match"), ",") {
		value = strings.TrimSpace(value)
		if value == "*" || value == wanted || value == "W/"+wanted {
			return true
		}
	}
	return false
}

func writeRawJSON(writer http.ResponseWriter, status int, body json.RawMessage) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}

func HTTPServer(address string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second,
	}
}
