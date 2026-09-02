package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"webmcp-automator/backend/internal/actionmap"
	"webmcp-automator/backend/internal/learning"
	"webmcp-automator/backend/internal/manifest"
)

//go:embed schema.sql
var schemaSQL string

type Store struct {
	db *sql.DB
}

type Session struct {
	ID         string          `json:"id"`
	Goal       string          `json:"goal"`
	StartURL   string          `json:"startUrl"`
	FinalURL   string          `json:"finalUrl"`
	Trace      json.RawMessage `json:"trace"`
	Status     string          `json:"status"`
	Model      string          `json:"model,omitempty"`
	ResponseID string          `json:"responseId,omitempty"`
	Error      *string         `json:"error,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
}

type Candidate struct {
	AdapterID  string           `json:"adapterId"`
	VersionID  string           `json:"versionId"`
	Version    int              `json:"version"`
	Status     string           `json:"status"`
	Manifest   manifest.Adapter `json:"manifest"`
	Confidence float64          `json:"confidence"`
	CreatedAt  time.Time        `json:"createdAt"`
}

type Discovery struct {
	ID        string        `json:"id"`
	SessionID string        `json:"sessionId"`
	ActionMap actionmap.Map `json:"actionMap"`
	Model     string        `json:"model"`
	CreatedAt time.Time     `json:"createdAt"`
}

type PublishedAdapter struct {
	AdapterID string           `json:"adapterId"`
	VersionID string           `json:"versionId"`
	Version   int              `json:"version"`
	Status    string           `json:"status"`
	Manifest  manifest.Adapter `json:"manifest"`
	CreatedAt time.Time        `json:"createdAt"`
}

type Run struct {
	VersionID  string          `json:"versionId"`
	Outcome    string          `json:"outcome"`
	FailedStep *int            `json:"failedStep"`
	URL        string          `json:"url"`
	Error      *string         `json:"error"`
	Observed   json.RawMessage `json:"observed,omitempty"`
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}
	dsn := path + "?_foreign_keys=on&_busy_timeout=5000&_journal_mode=WAL"
	if path == ":memory:" {
		dsn = "file:webmcp-test?mode=memory&cache=shared&_foreign_keys=on"
	}
	database, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	database.SetMaxOpenConns(1)
	if _, err := database.Exec(schemaSQL); err != nil {
		database.Close()
		return nil, fmt.Errorf("initialize database: %w", err)
	}
	return &Store{db: database}, nil
}

func (store *Store) Close() error {
	return store.db.Close()
}

func (store *Store) CreateSession(ctx context.Context, goal, startURL, finalURL string, trace json.RawMessage) (Session, error) {
	if !json.Valid(trace) {
		return Session{}, errors.New("trace must be valid JSON")
	}
	now := time.Now().UTC()
	session := Session{
		ID: newID("learn"), Goal: goal, StartURL: startURL, FinalURL: finalURL,
		Trace: trace, Status: "recorded", CreatedAt: now,
	}
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO learning_sessions
		  (id, goal, start_url, final_url, trace_json, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?)`,
		session.ID, goal, startURL, finalURL, string(trace), formatTime(now), formatTime(now),
	)
	if err != nil {
		return Session{}, fmt.Errorf("create learning session: %w", err)
	}
	return session, nil
}

func (store *Store) MarkLearning(ctx context.Context, sessionID string) error {
	return store.updateSession(ctx, sessionID, "learning", nil, "", "")
}

func (store *Store) MarkFailed(ctx context.Context, sessionID string, cause error) error {
	message := "learning failed"
	if cause != nil {
		message = cause.Error()
	}
	return store.updateSession(ctx, sessionID, "failed", &message, "", "")
}

func (store *Store) GetSession(ctx context.Context, sessionID string) (Session, error) {
	var session Session
	var traceText string
	var createdAt string
	var model sql.NullString
	var responseID sql.NullString
	var failure sql.NullString
	err := store.db.QueryRowContext(ctx, `
		SELECT id, goal, start_url, final_url, trace_json, status,
		       model, response_id, error, created_at
		FROM learning_sessions
		WHERE id = ?`, sessionID).Scan(
		&session.ID,
		&session.Goal,
		&session.StartURL,
		&session.FinalURL,
		&traceText,
		&session.Status,
		&model,
		&responseID,
		&failure,
		&createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, errors.New("learning session was not found")
	}
	if err != nil {
		return Session{}, fmt.Errorf("get learning session: %w", err)
	}
	session.Trace = json.RawMessage(traceText)
	session.Model = model.String
	session.ResponseID = responseID.String
	if failure.Valid {
		session.Error = &failure.String
	}
	session.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return session, nil
}

func (store *Store) SaveCandidate(ctx context.Context, sessionID string, result learning.Result) (Candidate, error) {
	return Candidate{}, errors.New("adapter candidate persistence is paused while action discovery is active")
}

func (store *Store) SaveDiscovery(ctx context.Context, sessionID string, result learning.Result) (Discovery, error) {
	mapJSON, err := json.Marshal(result.ActionMap)
	if err != nil {
		return Discovery{}, fmt.Errorf("encode action map: %w", err)
	}
	now := time.Now().UTC()
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Discovery{}, fmt.Errorf("begin discovery transaction: %w", err)
	}
	defer transaction.Rollback()

	siteID, err := upsertSite(ctx, transaction, result.ActionMap.Site.Origin, now)
	if err != nil {
		return Discovery{}, err
	}
	discoveryID := newID("map")
	if _, err := transaction.ExecContext(ctx, `
			INSERT INTO action_maps
			  (id, site_id, source_session_id, schema_version, map_json, model, response_id, created_at)
			VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?)`,
		discoveryID, siteID, sessionID, result.ActionMap.SchemaVersion,
		string(mapJSON), result.Model, result.ResponseID, formatTime(now),
	); err != nil {
		return Discovery{}, fmt.Errorf("save action map: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
			UPDATE learning_sessions
			SET site_id = ?, status = 'candidate', model = ?, response_id = ?, error = NULL, updated_at = ?
		WHERE id = ?`,
		siteID, result.Model, result.ResponseID, formatTime(now), sessionID,
	); err != nil {
		return Discovery{}, fmt.Errorf("complete discovery session: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Discovery{}, fmt.Errorf("commit action map: %w", err)
	}
	return Discovery{
		ID: discoveryID, SessionID: sessionID, ActionMap: result.ActionMap,
		Model: result.Model, CreatedAt: now,
	}, nil
}

func (store *Store) GetDiscovery(ctx context.Context, sessionID string) (Discovery, error) {
	var discovery Discovery
	var mapText string
	var model sql.NullString
	var createdAt string
	err := store.db.QueryRowContext(ctx, `
		SELECT id, source_session_id, map_json, model, created_at
		FROM action_maps
		WHERE source_session_id = ?`, sessionID).Scan(
		&discovery.ID,
		&discovery.SessionID,
		&mapText,
		&model,
		&createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Discovery{}, errors.New("action map was not found")
	}
	if err != nil {
		return Discovery{}, fmt.Errorf("get action map: %w", err)
	}
	if err := json.Unmarshal([]byte(mapText), &discovery.ActionMap); err != nil {
		return Discovery{}, fmt.Errorf("decode action map: %w", err)
	}
	discovery.Model = model.String
	discovery.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return discovery, nil
}

func (store *Store) Publish(ctx context.Context, adapterID, versionID string) error {
	now := formatTime(time.Now().UTC())
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin publish transaction: %w", err)
	}
	defer transaction.Rollback()

	var count int
	if err := transaction.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM adapter_versions WHERE id = ? AND adapter_id = ? AND status = 'candidate'",
		versionID, adapterID,
	).Scan(&count); err != nil || count != 1 {
		return errors.New("candidate adapter version was not found")
	}
	if _, err := transaction.ExecContext(ctx,
		"UPDATE adapter_versions SET status = 'superseded' WHERE adapter_id = ? AND status = 'active'", adapterID,
	); err != nil {
		return fmt.Errorf("supersede active version: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"UPDATE adapter_versions SET status = 'active', consecutive_failures = 0 WHERE id = ?", versionID,
	); err != nil {
		return fmt.Errorf("activate adapter version: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
		UPDATE adapters SET status = 'active', active_version_id = ?, updated_at = ? WHERE id = ?`,
		versionID, now, adapterID,
	); err != nil {
		return fmt.Errorf("activate adapter: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit adapter publication: %w", err)
	}
	return nil
}

func (store *Store) ListActive(ctx context.Context, origin string) ([]PublishedAdapter, error) {
	query := `
		SELECT a.id, v.id, v.version, a.status, v.manifest_json, v.created_at
		FROM adapters a
		JOIN sites s ON s.id = a.site_id
		JOIN adapter_versions v ON v.id = a.active_version_id
		WHERE a.status IN ('active', 'degraded')`
	arguments := []any{}
	if origin != "" {
		query += " AND s.origin = ?"
		arguments = append(arguments, origin)
	}
	query += " ORDER BY s.origin, a.tool_name"
	rows, err := store.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("list active adapters: %w", err)
	}
	defer rows.Close()

	adapters := []PublishedAdapter{}
	for rows.Next() {
		var adapter PublishedAdapter
		var manifestJSON string
		var createdAt string
		if err := rows.Scan(
			&adapter.AdapterID, &adapter.VersionID, &adapter.Version, &adapter.Status, &manifestJSON, &createdAt,
		); err != nil {
			return nil, fmt.Errorf("scan active adapter: %w", err)
		}
		if err := json.Unmarshal([]byte(manifestJSON), &adapter.Manifest); err != nil {
			return nil, fmt.Errorf("decode stored adapter: %w", err)
		}
		adapter.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		adapters = append(adapters, adapter)
	}
	return adapters, rows.Err()
}

func (store *Store) RecordRun(ctx context.Context, run Run) error {
	if run.Outcome != "success" && run.Outcome != "failure" {
		return errors.New("outcome must be success or failure")
	}
	if len(run.Observed) > 0 && !json.Valid(run.Observed) {
		return errors.New("observed must be valid JSON")
	}
	now := formatTime(time.Now().UTC())
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin run transaction: %w", err)
	}
	defer transaction.Rollback()
	var observed any
	if len(run.Observed) > 0 {
		observed = string(run.Observed)
	}
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO adapter_runs
		  (id, adapter_version_id, outcome, failed_step, url, error, observed_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		newID("run"), run.VersionID, run.Outcome, run.FailedStep, run.URL, run.Error, observed, now,
	); err != nil {
		return fmt.Errorf("record adapter run: %w", err)
	}
	if run.Outcome == "success" {
		if _, err := transaction.ExecContext(ctx,
			"UPDATE adapter_versions SET consecutive_failures = 0 WHERE id = ?", run.VersionID,
		); err != nil {
			return fmt.Errorf("reset adapter failures: %w", err)
		}
	} else {
		if _, err := transaction.ExecContext(ctx,
			"UPDATE adapter_versions SET consecutive_failures = consecutive_failures + 1 WHERE id = ?", run.VersionID,
		); err != nil {
			return fmt.Errorf("increment adapter failures: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
			UPDATE adapters SET status = 'degraded', updated_at = ?
			WHERE active_version_id = ?`, now, run.VersionID,
		); err != nil {
			return fmt.Errorf("mark adapter degraded: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit adapter run: %w", err)
	}
	return nil
}

func (store *Store) updateSession(ctx context.Context, sessionID, status string, message *string, model, responseID string) error {
	result, err := store.db.ExecContext(ctx, `
		UPDATE learning_sessions
		SET status = ?, error = ?, model = NULLIF(?, ''), response_id = NULLIF(?, ''), updated_at = ?
		WHERE id = ?`,
		status, message, model, responseID, formatTime(time.Now().UTC()), sessionID,
	)
	if err != nil {
		return fmt.Errorf("update learning session: %w", err)
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return errors.New("learning session was not found")
	}
	return nil
}

func upsertSite(ctx context.Context, transaction *sql.Tx, origin string, now time.Time) (string, error) {
	if _, err := url.ParseRequestURI(origin); err != nil {
		return "", errors.New("adapter origin is invalid")
	}
	var siteID string
	err := transaction.QueryRowContext(ctx, "SELECT id FROM sites WHERE origin = ?", origin).Scan(&siteID)
	if err == nil {
		_, _ = transaction.ExecContext(ctx, "UPDATE sites SET updated_at = ? WHERE id = ?", formatTime(now), siteID)
		return siteID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("find site: %w", err)
	}
	siteID = newID("site")
	if _, err := transaction.ExecContext(ctx,
		"INSERT INTO sites (id, origin, created_at, updated_at) VALUES (?, ?, ?, ?)",
		siteID, origin, formatTime(now), formatTime(now),
	); err != nil {
		return "", fmt.Errorf("create site: %w", err)
	}
	return siteID, nil
}

func upsertAdapter(ctx context.Context, transaction *sql.Tx, siteID, toolName string, now time.Time) (string, error) {
	var adapterID string
	err := transaction.QueryRowContext(ctx,
		"SELECT id FROM adapters WHERE site_id = ? AND tool_name = ?", siteID, toolName,
	).Scan(&adapterID)
	if err == nil {
		return adapterID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("find adapter: %w", err)
	}
	adapterID = newID("adapter")
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO adapters (id, site_id, tool_name, status, created_at, updated_at)
		VALUES (?, ?, ?, 'draft', ?, ?)`,
		adapterID, siteID, toolName, formatTime(now), formatTime(now),
	); err != nil {
		return "", fmt.Errorf("create adapter: %w", err)
	}
	return adapterID, nil
}

func newID(prefix string) string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return prefix + "_" + hex.EncodeToString(buffer)
}

func formatTime(value time.Time) string {
	return value.Format(time.RFC3339Nano)
}
