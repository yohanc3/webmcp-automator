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
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/learning"
	"webmcp-automator/server/internal/manifest"
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

func Open(databaseURL string) (*Store, error) {
	databaseURL = strings.TrimSpace(databaseURL)
	if databaseURL == "" {
		return nil, errors.New("DB_URL is not configured")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		return nil, errors.New("DB_URL must be a PostgreSQL connection URL")
	}
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open PostgreSQL database: %w", err)
	}
	database.SetMaxOpenConns(10)
	database.SetMaxIdleConns(2)
	database.SetConnMaxIdleTime(5 * time.Minute)
	connectContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := database.PingContext(connectContext); err != nil {
		database.Close()
		return nil, fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	if err := initializeSchema(connectContext, database); err != nil {
		database.Close()
		return nil, fmt.Errorf("initialize PostgreSQL schema: %w", err)
	}
	return &Store{db: database}, nil
}

func New(database *sql.DB) *Store {
	return &Store{db: database}
}

func initializeSchema(ctx context.Context, database *sql.DB) error {
	for _, rawStatement := range strings.Split(schemaSQL, ";") {
		statement := strings.TrimSpace(rawStatement)
		if statement == "" {
			continue
		}
		if _, err := database.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
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
		VALUES ($1, $2, $3, $4, $5, 'recorded', $6, $7)`,
		session.ID, goal, startURL, finalURL, string(trace), now, now,
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
	var model sql.NullString
	var responseID sql.NullString
	var failure sql.NullString
	err := store.db.QueryRowContext(ctx, `
		SELECT id, goal, start_url, final_url, trace_json, status,
		       model, response_id, error, created_at
		FROM learning_sessions
		WHERE id = $1`, sessionID).Scan(
		&session.ID,
		&session.Goal,
		&session.StartURL,
		&session.FinalURL,
		&traceText,
		&session.Status,
		&model,
		&responseID,
		&failure,
		&session.CreatedAt,
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
			VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8)`,
		discoveryID, siteID, sessionID, result.ActionMap.SchemaVersion,
		string(mapJSON), result.Model, result.ResponseID, now,
	); err != nil {
		return Discovery{}, fmt.Errorf("save action map: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
			UPDATE learning_sessions
			SET site_id = $1, status = 'candidate', model = $2, response_id = $3, error = NULL, updated_at = $4
			WHERE id = $5`,
		siteID, result.Model, result.ResponseID, now, sessionID,
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
	err := store.db.QueryRowContext(ctx, `
		SELECT id, source_session_id, map_json, model, created_at
		FROM action_maps
		WHERE source_session_id = $1`, sessionID).Scan(
		&discovery.ID,
		&discovery.SessionID,
		&mapText,
		&model,
		&discovery.CreatedAt,
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
	return discovery, nil
}

func (store *Store) Publish(ctx context.Context, adapterID, versionID string) error {
	return fmt.Errorf(
		"%w: /api/adapters/publish cannot bypass digest, policy, replay, and review checks; use the v1 publication route",
		ErrGate,
	)
}

func (store *Store) ListActive(ctx context.Context, origin string) ([]PublishedAdapter, error) {
	if origin == "" {
		return nil, errors.New("origin is required for legacy adapter discovery")
	}
	revisions, err := store.DiscoverActionLists(ctx, origin, "")
	if err != nil {
		return nil, err
	}
	return legacyAdapters(revisions)
}

func (store *Store) RecordRun(ctx context.Context, run Run) error {
	return store.recordLegacyRun(ctx, run)
}

func (store *Store) updateSession(ctx context.Context, sessionID, status string, message *string, model, responseID string) error {
	result, err := store.db.ExecContext(ctx, `
		UPDATE learning_sessions
		SET status = $1, error = $2, model = NULLIF($3, ''), response_id = NULLIF($4, ''), updated_at = $5
		WHERE id = $6`,
		status, message, model, responseID, time.Now().UTC(), sessionID,
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
	siteID := newID("site")
	if err := transaction.QueryRowContext(ctx, `
		INSERT INTO sites (id, origin, created_at, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (origin) DO UPDATE SET updated_at = EXCLUDED.updated_at
		RETURNING id`,
		siteID, origin, now, now,
	).Scan(&siteID); err != nil {
		return "", fmt.Errorf("upsert site: %w", err)
	}
	return siteID, nil
}

func upsertAdapter(ctx context.Context, transaction *sql.Tx, siteID, toolName string, now time.Time) (string, error) {
	adapterID := newID("adapter")
	if err := transaction.QueryRowContext(ctx, `
		INSERT INTO adapters (id, site_id, tool_name, status, created_at, updated_at)
		VALUES ($1, $2, $3, 'draft', $4, $5)
		ON CONFLICT (site_id, tool_name) DO UPDATE SET updated_at = EXCLUDED.updated_at
		RETURNING id`,
		adapterID, siteID, toolName, now, now,
	).Scan(&adapterID); err != nil {
		return "", fmt.Errorf("upsert adapter: %w", err)
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
