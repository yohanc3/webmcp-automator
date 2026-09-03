package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

func (store *Store) ApplyActionMapPatch(
	ctx context.Context,
	input ApplyActionMapRequest,
) (ActionMapReceipt, error) {
	now := time.Now().UTC()
	routePatterns, err := canonicalJSON(input.Request.SiteScope.RoutePatterns)
	if err != nil {
		return ActionMapReceipt{}, err
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return ActionMapReceipt{}, fmt.Errorf("begin action map application: %w", err)
	}
	defer transaction.Rollback()

	insertedScope := false
	var insertedID string
	err = transaction.QueryRowContext(ctx, `
		INSERT INTO action_map_scopes
		  (scope_id, origin, route_patterns_json, head_revision, head_digest,
		   last_layer_sequence, created_at, updated_at)
		VALUES ($1, $2, $3, 0, NULL, 0, $4, $4)
		ON CONFLICT (scope_id) DO NOTHING
		RETURNING scope_id`, input.Request.SiteScope.ScopeID, input.Request.SiteScope.Origin,
		string(routePatterns), now).Scan(&insertedID)
	if err == nil {
		insertedScope = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		return ActionMapReceipt{}, fmt.Errorf("initialize action map scope: %w", err)
	}

	var storedOrigin string
	var storedRoutes string
	var headRevision int
	var headDigest sql.NullString
	var lastLayerSequence int
	if err := transaction.QueryRowContext(ctx, `
		SELECT origin, route_patterns_json, head_revision, head_digest, last_layer_sequence
		FROM action_map_scopes
		WHERE scope_id = $1
		FOR UPDATE`, input.Request.SiteScope.ScopeID).Scan(
		&storedOrigin, &storedRoutes, &headRevision, &headDigest, &lastLayerSequence,
	); err != nil {
		return ActionMapReceipt{}, fmt.Errorf("lock action map scope: %w", err)
	}
	var storedRoutePatterns []string
	if err := json.Unmarshal([]byte(storedRoutes), &storedRoutePatterns); err != nil {
		return ActionMapReceipt{}, fmt.Errorf("decode stored action map scope: %w", err)
	}
	storedScope := SiteScope{
		ScopeID: input.Request.SiteScope.ScopeID, Origin: storedOrigin,
		RoutePatterns: storedRoutePatterns,
	}

	current, metadata, err := loadLockedActionMap(
		ctx, transaction, storedScope, headRevision, headDigest, lastLayerSequence,
	)
	if err != nil {
		return ActionMapReceipt{}, err
	}
	if !sameSiteScope(storedScope, input.Request.SiteScope) {
		receipt := reusedScopeReceipt(input, current, now)
		return receipt, nil
	}

	inputDigest, digestErr := applicationInputDigest(input)
	if digestErr == nil {
		storedReceipt, storedInputDigest, found, err := loadActionMapReceipt(
			ctx, transaction, input.Request.SiteScope.ScopeID, input.Request.IdempotencyKey,
		)
		if err != nil {
			return ActionMapReceipt{}, err
		}
		if found {
			if storedInputDigest != inputDigest {
				receipt := reusedKeyReceipt(input, current, now)
				if err := transaction.Commit(); err != nil {
					return ActionMapReceipt{}, fmt.Errorf("commit reused-key read: %w", err)
				}
				return receipt, nil
			}
			if err := transaction.Commit(); err != nil {
				return ActionMapReceipt{}, fmt.Errorf("commit duplicate read: %w", err)
			}
			return duplicateReceipt(storedReceipt), nil
		}
	}

	prepared := prepareActionMapApplication(input, current, metadata, now)
	shouldPersistReceipt := !insertedScope || prepared.append || prepared.advanceLayer
	if prepared.append {
		canonicalMapJSON, err := canonicalJSON(prepared.snapshot.ActionMap)
		if err != nil {
			return ActionMapReceipt{}, fmt.Errorf("encode action map revision: %w", err)
		}
		metadataJSON, err := canonicalJSON(prepared.metadata)
		if err != nil {
			return ActionMapReceipt{}, fmt.Errorf("encode action map evidence metadata: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO action_map_revisions
			  (scope_id, revision, digest, source_layer_sequence, schema_version,
			   document_json, evidence_metadata_json, parser_id, parser_version,
			   prompt_version, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			prepared.snapshot.SiteScopeID, prepared.snapshot.Revision, *prepared.snapshot.Digest,
			prepared.snapshot.SourceLayerSequence, prepared.snapshot.ActionMap.SchemaVersion,
			string(canonicalMapJSON), string(metadataJSON), input.Patch.Parser.ParserID,
			input.Patch.Parser.ParserVersion, input.Patch.Parser.PromptVersion, now,
		); err != nil {
			return ActionMapReceipt{}, fmt.Errorf("append action map revision: %w", err)
		}
	}
	if prepared.advanceLayer {
		result := pointerFromSnapshot(prepared.snapshot)
		if _, err := transaction.ExecContext(ctx, `
			UPDATE action_map_scopes
			SET head_revision = $1, head_digest = $2, last_layer_sequence = $3, updated_at = $4
			WHERE scope_id = $5`, result.Revision, nullableDigest(result.Digest),
			input.Request.Layer.Sequence, now, input.Request.SiteScope.ScopeID,
		); err != nil {
			return ActionMapReceipt{}, fmt.Errorf("advance action map head: %w", err)
		}
	}
	if shouldPersistReceipt && prepared.inputDigest != "" &&
		digestPattern.MatchString(prepared.receipt.IdempotencyKey) {
		if err := storeActionMapReceipt(ctx, transaction, prepared.receipt, prepared.inputDigest, now); err != nil {
			return ActionMapReceipt{}, err
		}
	}
	if !shouldPersistReceipt {
		return prepared.receipt, nil
	}
	if err := transaction.Commit(); err != nil {
		return ActionMapReceipt{}, fmt.Errorf("commit action map application: %w", err)
	}
	return prepared.receipt, nil
}

func (store *Store) GetActionMapHead(
	ctx context.Context,
	scopeID string,
) (ActionMapSnapshot, error) {
	var scope SiteScope
	var routePatterns string
	var revision int
	var digest sql.NullString
	var layerSequence int
	err := store.db.QueryRowContext(ctx, `
		SELECT scope_id, origin, route_patterns_json, head_revision, head_digest, last_layer_sequence
		FROM action_map_scopes
		WHERE scope_id = $1`, scopeID).Scan(
		&scope.ScopeID, &scope.Origin, &routePatterns, &revision, &digest, &layerSequence,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ActionMapSnapshot{}, ErrActionMapNotFound
	}
	if err != nil {
		return ActionMapSnapshot{}, fmt.Errorf("get action map head: %w", err)
	}
	if err := json.Unmarshal([]byte(routePatterns), &scope.RoutePatterns); err != nil {
		return ActionMapSnapshot{}, fmt.Errorf("decode action map scope routes: %w", err)
	}
	snapshot, _, err := loadActionMap(ctx, store.db, scope, revision, digest, layerSequence)
	return snapshot, err
}

func (store *Store) GetActionMapRevision(
	ctx context.Context,
	scopeID string,
	revision int,
) (ActionMapSnapshot, error) {
	if revision < 1 {
		return ActionMapSnapshot{}, ErrActionMapNotFound
	}
	var snapshot ActionMapSnapshot
	var digest string
	var document string
	var createdAt time.Time
	err := store.db.QueryRowContext(ctx, `
		SELECT scope_id, revision, digest, source_layer_sequence, document_json, created_at
		FROM action_map_revisions
		WHERE scope_id = $1 AND revision = $2`, scopeID, revision).Scan(
		&snapshot.SiteScopeID, &snapshot.Revision, &digest, &snapshot.SourceLayerSequence,
		&document, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ActionMapSnapshot{}, ErrActionMapNotFound
	}
	if err != nil {
		return ActionMapSnapshot{}, fmt.Errorf("get action map revision: %w", err)
	}
	if err := json.Unmarshal([]byte(document), &snapshot.ActionMap); err != nil {
		return ActionMapSnapshot{}, fmt.Errorf("decode action map revision: %w", err)
	}
	actual, _, err := canonicalMap(snapshot.ActionMap)
	if err != nil || actual != digest {
		return ActionMapSnapshot{}, errors.New("stored action map digest is invalid")
	}
	snapshot.Digest = &digest
	snapshot.CreatedAt = &createdAt
	return snapshot, nil
}

func (store *Store) GetActionMapContext(
	ctx context.Context,
	scopeID string,
	revision int,
) (ActionMapContext, error) {
	if revision < 0 {
		return ActionMapContext{}, ErrActionMapNotFound
	}
	if revision == 0 {
		head, err := store.GetActionMapHead(ctx, scopeID)
		if err != nil || head.Revision != 0 {
			return ActionMapContext{}, ErrActionMapNotFound
		}
		return ProjectActionMapContext(head, safeRevisionMetadata{}), nil
	}
	var snapshot ActionMapSnapshot
	var digest string
	var document string
	var metadataJSON string
	var createdAt time.Time
	var headRevision int
	var lastLayerSequence int
	err := store.db.QueryRowContext(ctx, `
	SELECT action_map_revisions.scope_id, action_map_revisions.revision,
	       action_map_revisions.digest, action_map_revisions.source_layer_sequence,
	       action_map_revisions.document_json, action_map_revisions.evidence_metadata_json,
	       action_map_revisions.created_at, action_map_scopes.head_revision,
	       action_map_scopes.last_layer_sequence
	FROM action_map_revisions
	JOIN action_map_scopes ON action_map_scopes.scope_id = action_map_revisions.scope_id
	WHERE action_map_revisions.scope_id = $1 AND action_map_revisions.revision = $2`, scopeID, revision).Scan(
		&snapshot.SiteScopeID, &snapshot.Revision, &digest, &snapshot.SourceLayerSequence,
		&document, &metadataJSON, &createdAt, &headRevision, &lastLayerSequence,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ActionMapContext{}, ErrActionMapNotFound
	}
	if err != nil {
		return ActionMapContext{}, fmt.Errorf("get action map context: %w", err)
	}
	var metadata safeRevisionMetadata
	if err := json.Unmarshal([]byte(document), &snapshot.ActionMap); err != nil {
		return ActionMapContext{}, fmt.Errorf("decode action map context map: %w", err)
	}
	if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil {
		return ActionMapContext{}, fmt.Errorf("decode action map context evidence: %w", err)
	}
	actual, _, err := canonicalMap(snapshot.ActionMap)
	if err != nil || actual != digest {
		return ActionMapContext{}, errors.New("stored action map context digest is invalid")
	}
	snapshot.Digest = &digest
	snapshot.CreatedAt = &createdAt
	if snapshot.Revision == headRevision {
		snapshot.SourceLayerSequence = lastLayerSequence
	}
	return ProjectActionMapContext(snapshot, metadata), nil
}

type actionMapQueryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadLockedActionMap(
	ctx context.Context,
	transaction *sql.Tx,
	scope SiteScope,
	revision int,
	digest sql.NullString,
	layerSequence int,
) (ActionMapSnapshot, safeRevisionMetadata, error) {
	return loadActionMap(ctx, transaction, scope, revision, digest, layerSequence)
}

func loadActionMap(
	ctx context.Context,
	querier actionMapQueryRower,
	scope SiteScope,
	revision int,
	digest sql.NullString,
	layerSequence int,
) (ActionMapSnapshot, safeRevisionMetadata, error) {
	if revision == 0 {
		snapshot := seedActionMap(scope)
		snapshot.SourceLayerSequence = layerSequence
		return snapshot, safeRevisionMetadata{
			Entities: []safeEntityMetadata{}, Evidence: []EvidenceCitation{}, Bindings: []safeEvidenceBinding{},
		}, nil
	}
	var snapshot ActionMapSnapshot
	var storedDigest string
	var document string
	var metadataJSON string
	var createdAt time.Time
	err := querier.QueryRowContext(ctx, `
		SELECT scope_id, revision, digest, source_layer_sequence, document_json,
		       evidence_metadata_json, created_at
		FROM action_map_revisions
		WHERE scope_id = $1 AND revision = $2`, scope.ScopeID, revision).Scan(
		&snapshot.SiteScopeID, &snapshot.Revision, &storedDigest, &snapshot.SourceLayerSequence,
		&document, &metadataJSON, &createdAt,
	)
	if err != nil {
		return ActionMapSnapshot{}, safeRevisionMetadata{}, fmt.Errorf("load action map head revision: %w", err)
	}
	if !digest.Valid || digest.String != storedDigest {
		return ActionMapSnapshot{}, safeRevisionMetadata{}, errors.New("stored action map head digest is invalid")
	}
	var metadata safeRevisionMetadata
	if err := json.Unmarshal([]byte(document), &snapshot.ActionMap); err != nil {
		return ActionMapSnapshot{}, safeRevisionMetadata{}, fmt.Errorf("decode action map head: %w", err)
	}
	if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil {
		return ActionMapSnapshot{}, safeRevisionMetadata{}, fmt.Errorf("decode action map head evidence: %w", err)
	}
	actual, _, err := canonicalMap(snapshot.ActionMap)
	if err != nil || actual != storedDigest {
		return ActionMapSnapshot{}, safeRevisionMetadata{}, errors.New("stored action map head document is invalid")
	}
	snapshot.Digest = &storedDigest
	snapshot.CreatedAt = &createdAt
	snapshot.SourceLayerSequence = layerSequence
	return snapshot, metadata, nil
}

func storeActionMapReceipt(
	ctx context.Context,
	transaction *sql.Tx,
	receipt ActionMapReceipt,
	inputDigest string,
	now time.Time,
) error {
	receiptJSON, err := canonicalJSON(receipt)
	if err != nil {
		return fmt.Errorf("encode action map receipt: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO action_map_receipts
		  (scope_id, idempotency_key, input_digest, source_layer_sequence, receipt_json, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`, receipt.SiteScopeID, receipt.IdempotencyKey,
		inputDigest, receipt.SourceLayerSequence, string(receiptJSON), now,
	); err != nil {
		return fmt.Errorf("store action map receipt: %w", err)
	}
	return nil
}

func loadActionMapReceipt(
	ctx context.Context,
	transaction *sql.Tx,
	scopeID string,
	idempotencyKey string,
) (ActionMapReceipt, string, bool, error) {
	var inputDigest string
	var receiptJSON string
	err := transaction.QueryRowContext(ctx, `
		SELECT input_digest, receipt_json
		FROM action_map_receipts
		WHERE scope_id = $1 AND idempotency_key = $2`, scopeID, idempotencyKey).Scan(
		&inputDigest, &receiptJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ActionMapReceipt{}, "", false, nil
	}
	if err != nil {
		return ActionMapReceipt{}, "", false, fmt.Errorf("load action map receipt: %w", err)
	}
	var receipt ActionMapReceipt
	if err := json.Unmarshal([]byte(receiptJSON), &receipt); err != nil {
		return ActionMapReceipt{}, "", false, fmt.Errorf("decode action map receipt: %w", err)
	}
	return receipt, inputDigest, true, nil
}

func reusedScopeReceipt(input ApplyActionMapRequest, current ActionMapSnapshot, now time.Time) ActionMapReceipt {
	receipt := baseReceipt(input, pointerFromBase(input.Patch.MapBase), pointerFromSnapshot(current), now)
	code := "VALIDATION_FAILED"
	receipt.Application.ConflictCode = &code
	return receipt
}

func nullableDigest(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
