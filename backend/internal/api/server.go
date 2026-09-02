package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"webmcp-automator/backend/internal/actionmap"
	"webmcp-automator/backend/internal/learning"
	"webmcp-automator/backend/internal/privacy"
	"webmcp-automator/backend/internal/store"
	learningtrace "webmcp-automator/backend/internal/trace"
)

const maxRequestBytes = 8 << 20

type Discoverer interface {
	Discover(context.Context, json.RawMessage) (learning.Result, error)
}

type Server struct {
	store            *store.Store
	discoverer       Discoverer
	apiKeyConfigured bool
	provider         string
	model            string
	demoDirectory    string
	handler          http.Handler
}

type learnRequest struct {
	Trace json.RawMessage `json:"trace"`
}

type publishRequest struct {
	AdapterID string `json:"adapterId"`
	VersionID string `json:"versionId"`
}

func New(
	database *store.Store,
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
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", server.health)
	mux.HandleFunc("POST /api/discover", server.discover)
	mux.HandleFunc("GET /api/discover/{sessionID}", server.discoveryStatus)
	mux.HandleFunc("POST /api/learn", server.discover)
	mux.HandleFunc("GET /api/adapters", server.listAdapters)
	mux.HandleFunc("POST /api/adapters/publish", server.publish)
	mux.HandleFunc("POST /api/runs", server.recordRun)
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
		"provider": server.provider, "database": "sqlite",
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
	var input publishRequest
	if err := readJSON(writer, request, &input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if input.AdapterID == "" || input.VersionID == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "adapterId and versionId are required"})
		return
	}
	if err := server.store.Publish(request.Context(), input.AdapterID, input.VersionID); err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"published": true})
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
		writer.Header().Set("Access-Control-Allow-Origin", "*")
		writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		writer.Header().Set("Cache-Control", "no-store")
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(writer, request)
	})
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
