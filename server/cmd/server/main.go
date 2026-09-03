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

	"webmcp-automator/server/internal/api"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/store"
)

func main() {
	if err := loadDotEnv(".env"); err != nil {
		log.Fatal(err)
	}

	host := environment("WEBMCP_LEARN_HOST", "127.0.0.1")
	port := environment("WEBMCP_LEARN_PORT", "4317")
	model := environment("OPENROUTER_MODEL", "openai/gpt-oss-20b:nitro")
	databaseURL := environment("DB_URL", "")
	demoDirectory := environment("WEBMCP_DEMO_DIR", filepath.Join("..", "workspace", "demo"))
	apiKey := strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY"))

	database, err := store.Open(databaseURL)
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
	fmt.Println("PostgreSQL database: connected")
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

func loadDotEnv(path string) error {
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	for lineNumber, line := range strings.Split(string(contents), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			return fmt.Errorf("invalid .env assignment at line %d", lineNumber+1)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			first, last := value[0], value[len(value)-1]
			if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("set %s from .env: %w", key, err)
		}
	}
	return nil
}
