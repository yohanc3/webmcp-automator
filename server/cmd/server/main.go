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
	"webmcp-automator/server/internal/config"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/store"
)

func main() {
	if err := config.LoadDotEnv(".env"); err != nil {
		log.Fatal(err)
	}

	host := environment("WEBMCP_LEARN_HOST", "127.0.0.1")
	port := environment("WEBMCP_LEARN_PORT", "4317")
	databaseURL := environment("DB_URL", "")
	demoDirectory := environment("WEBMCP_DEMO_DIR", filepath.Join("..", "workspace", "demo"))
	learner := learning.NewClient(
		os.Getenv("CEREBRAS_API_KEY"),
		os.Getenv("OPENROUTER_API_KEY"),
	)
	configuration := learner.Configuration()

	database, err := store.Open(databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer database.Close()

	handler := api.New(
		database,
		learner,
		configuration.APIKeyConfigured,
		configuration.Provider,
		configuration.Model,
		demoDirectory,
	)
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
	if configuration.APIKeyConfigured {
		fmt.Printf("AI provider: %s (%s)\n", configuration.Provider, configuration.Model)
	} else {
		fmt.Println("No AI provider is configured; set CEREBRAS_API_KEY or OPENROUTER_API_KEY to enable synthesis.")
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
