package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

var ErrActionMapNotFound = errors.New("action map revision was not found")

type ActionMapService interface {
	ApplyActionMapPatch(context.Context, ApplyActionMapRequest) (ActionMapReceipt, error)
	GetActionMapHead(context.Context, string) (ActionMapSnapshot, error)
	GetActionMapRevision(context.Context, string, int) (ActionMapSnapshot, error)
	GetActionMapContext(context.Context, string, int) (ActionMapContext, error)
}

type memoryActionMapScope struct {
	scope        SiteScope
	head         ActionMapSnapshot
	metadata     safeRevisionMetadata
	revisions    map[int]ActionMapSnapshot
	revisionMeta map[int]safeRevisionMetadata
	receipts     map[string]memoryActionMapReceipt
}

type memoryActionMapReceipt struct {
	inputDigest string
	receipt     ActionMapReceipt
}

type MemoryActionMapStore struct {
	mu     sync.Mutex
	scopes map[string]*memoryActionMapScope
	now    func() time.Time
}

func NewMemoryActionMapStore() *MemoryActionMapStore {
	return &MemoryActionMapStore{
		scopes: make(map[string]*memoryActionMapScope),
		now:    time.Now,
	}
}

func (store *MemoryActionMapStore) ApplyActionMapPatch(
	_ context.Context,
	input ApplyActionMapRequest,
) (ActionMapReceipt, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	scopeID := input.Request.SiteScope.ScopeID
	scope, exists := store.scopes[scopeID]
	current := seedActionMap(input.Request.SiteScope)
	metadata := safeRevisionMetadata{
		Entities: []safeEntityMetadata{}, Evidence: []EvidenceCitation{}, Bindings: []safeEvidenceBinding{},
	}
	if exists {
		if !sameSiteScope(scope.scope, input.Request.SiteScope) {
			prepared := prepareActionMapApplication(input, scope.head, scope.metadata, store.now().UTC())
			prepared.receipt = rejectedMaterialization(
				prepared.receipt, "VALIDATION_FAILED", scope.head, scope.metadata, prepared.inputDigest,
			).receipt
			return prepared.receipt, nil
		}
		current = cloneSnapshot(scope.head)
		metadata = cloneMetadata(scope.metadata)
		if digestPattern.MatchString(input.Request.IdempotencyKey) {
			if stored, duplicate := scope.receipts[input.Request.IdempotencyKey]; duplicate {
				digest, err := applicationInputDigest(input)
				if err != nil || digest != stored.inputDigest {
					return reusedKeyReceipt(input, current, store.now().UTC()), nil
				}
				return duplicateReceipt(cloneReceipt(stored.receipt)), nil
			}
		}
	}

	prepared := prepareActionMapApplication(input, current, metadata, store.now().UTC())
	if prepared.inputDigest == "" {
		return prepared.receipt, nil
	}
	if !exists && (prepared.append || prepared.advanceLayer) {
		scope = &memoryActionMapScope{
			scope:        input.Request.SiteScope,
			head:         current,
			metadata:     metadata,
			revisions:    make(map[int]ActionMapSnapshot),
			revisionMeta: make(map[int]safeRevisionMetadata),
			receipts:     make(map[string]memoryActionMapReceipt),
		}
		store.scopes[scopeID] = scope
		exists = true
	}
	if exists {
		if prepared.append {
			scope.head = cloneSnapshot(prepared.snapshot)
			scope.metadata = cloneMetadata(prepared.metadata)
			scope.revisions[prepared.snapshot.Revision] = cloneSnapshot(prepared.snapshot)
			scope.revisionMeta[prepared.snapshot.Revision] = cloneMetadata(prepared.metadata)
		} else if prepared.advanceLayer {
			scope.head.SourceLayerSequence = input.Request.Layer.Sequence
		}
		if digestPattern.MatchString(input.Request.IdempotencyKey) {
			scope.receipts[input.Request.IdempotencyKey] = memoryActionMapReceipt{
				inputDigest: prepared.inputDigest,
				receipt:     cloneReceipt(prepared.receipt),
			}
		}
	}
	return cloneReceipt(prepared.receipt), nil
}

func (store *MemoryActionMapStore) GetActionMapHead(
	_ context.Context,
	scopeID string,
) (ActionMapSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	scope, exists := store.scopes[scopeID]
	if !exists {
		return ActionMapSnapshot{}, ErrActionMapNotFound
	}
	return cloneSnapshot(scope.head), nil
}

func (store *MemoryActionMapStore) GetActionMapRevision(
	_ context.Context,
	scopeID string,
	revision int,
) (ActionMapSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	scope, exists := store.scopes[scopeID]
	if !exists {
		return ActionMapSnapshot{}, ErrActionMapNotFound
	}
	result, exists := scope.revisions[revision]
	if !exists {
		return ActionMapSnapshot{}, ErrActionMapNotFound
	}
	return cloneSnapshot(result), nil
}

func (store *MemoryActionMapStore) GetActionMapContext(
	_ context.Context,
	scopeID string,
	revision int,
) (ActionMapContext, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	scope, exists := store.scopes[scopeID]
	if !exists {
		return ActionMapContext{}, ErrActionMapNotFound
	}
	if revision == 0 && scope.head.Revision == 0 {
		return ProjectActionMapContext(scope.head, scope.metadata), nil
	}
	snapshot, exists := scope.revisions[revision]
	if !exists {
		return ActionMapContext{}, ErrActionMapNotFound
	}
	return ProjectActionMapContext(snapshot, scope.revisionMeta[revision]), nil
}

func (store *MemoryActionMapStore) ActionMapRevisionCount(scopeID string) int {
	store.mu.Lock()
	defer store.mu.Unlock()
	if scope, exists := store.scopes[scopeID]; exists {
		return len(scope.revisions)
	}
	return 0
}

func sameSiteScope(left, right SiteScope) bool {
	leftJSON, _ := canonicalJSON(left)
	rightJSON, _ := canonicalJSON(right)
	return string(leftJSON) == string(rightJSON)
}

func cloneSnapshot(value ActionMapSnapshot) ActionMapSnapshot {
	var result ActionMapSnapshot
	cloneJSON(value, &result)
	return result
}

func cloneMetadata(value safeRevisionMetadata) safeRevisionMetadata {
	var result safeRevisionMetadata
	cloneJSON(value, &result)
	return result
}

func cloneReceipt(value ActionMapReceipt) ActionMapReceipt {
	var result ActionMapReceipt
	cloneJSON(value, &result)
	return result
}

func cloneJSON(value, target any) {
	encoded, _ := json.Marshal(value)
	_ = json.Unmarshal(encoded, target)
}
