package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"webmcp-automator/backend/internal/api"
	"webmcp-automator/backend/internal/learning"
	"webmcp-automator/backend/internal/store"
)

func main() {
	host := environment("WEBMCP_LEARN_HOST", "127.0.0.1")
	port := environment("WEBMCP_LEARN_PORT", "4317")
	model := environment("OPENROUTER_MODEL", "openai/gpt-oss-20b:nitro")
	databasePath := environment("WEBMCP_DB_PATH", filepath.Join("data", "webmcp.db"))
	demoDirectory := environment("WEBMCP_DEMO_DIR", filepath.Join("..", "demo"))
	apiKey := strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY"))

	database, err := store.Open(databasePath)
	if err != nil {
		log.Fatal(err)
	}
	defer database.Close()

	learner := learning.Client{APIKey: apiKey, Model: model}
	handler := api.New(database, learner, apiKey != "", "openrouter", model, demoDirectory)
	address := host + ":" + port
	server := api.HTTPServer(address, handler)

	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-shutdownSignals
		context, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(context)
	}()

	fmt.Printf("WebMCP learning service: http://%s\n", address)
	fmt.Printf("Demo storefront: http://%s/demo/\n", address)
	fmt.Printf("SQLite database: %s\n", databasePath)
	if apiKey == "" {
		fmt.Println("OPENROUTER_API_KEY is not configured; recording and persistence work, synthesis does not.")
	}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func environment(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}
