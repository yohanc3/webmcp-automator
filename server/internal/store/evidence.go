package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"webmcp-automator/server/internal/manifest"
)

type EvidenceResolution struct {
	SchemaVersion string                  `json:"schemaVersion"`
	Binding       CandidateBinding        `json:"binding"`
	ReferenceID   string                  `json:"referenceId"`
	Matches       []EvidenceResolutionHit `json:"matches"`
}

type EvidenceResolutionHit struct {
	EntityKind    string  `json:"entityKind"`
	EntityID      string  `json:"entityId"`
	Provenance    string  `json:"provenance"`
	LayerSequence int     `json:"layerSequence"`
	LayerID       string  `json:"layerId"`
	EvidenceID    string  `json:"evidenceId"`
	ContentDigest string  `json:"contentDigest"`
	BindingRole   string  `json:"bindingRole"`
	StepIndex     *int    `json:"stepIndex"`
	FieldName     *string `json:"fieldName"`
}

func (store *Store) ResolveCandidateEvidence(
	ctx context.Context,
	listID string,
	revision int,
	referenceID string,
) (EvidenceResolution, error) {
	if !boundedIdentifier(listID, 80) || revision < 1 || !boundedIdentifier(referenceID, 128) {
		return EvidenceResolution{}, errors.New("candidate evidence reference is invalid")
	}
	var binding CandidateBinding
	var storedCandidateDigest string
	var headRevision int
	var headDigest sql.NullString
	var storedMapDigest string
	var metadataJSON string
	var candidateJSON string
	err := store.db.QueryRowContext(ctx, `
		SELECT bindings.candidate_digest, bindings.scope_id,
		       bindings.action_map_revision, bindings.action_map_digest,
		       revisions.candidate_digest, scopes.head_revision, scopes.head_digest,
		       maps.digest, maps.evidence_metadata_json, revisions.document_json
		FROM action_list_candidate_bindings AS bindings
		JOIN action_list_revisions AS revisions
		  ON revisions.list_id = bindings.list_id AND revisions.revision = bindings.revision
		JOIN action_map_scopes AS scopes ON scopes.scope_id = bindings.scope_id
		JOIN action_map_revisions AS maps
		  ON maps.scope_id = bindings.scope_id AND maps.revision = bindings.action_map_revision
		WHERE bindings.list_id = $1 AND bindings.revision = $2`, listID, revision).Scan(
		&binding.CandidateDigest, &binding.ScopeID, &binding.ActionMapRevision,
		&binding.ActionMapDigest, &storedCandidateDigest, &headRevision, &headDigest, &storedMapDigest,
		&metadataJSON, &candidateJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return EvidenceResolution{}, ErrNotFound
	}
	if err != nil {
		return EvidenceResolution{}, fmt.Errorf("load candidate evidence binding: %w", err)
	}
	binding.ListID, binding.Revision = listID, revision
	if storedCandidateDigest != binding.CandidateDigest || storedMapDigest != binding.ActionMapDigest || !headDigest.Valid ||
		headRevision != binding.ActionMapRevision || headDigest.String != binding.ActionMapDigest {
		return EvidenceResolution{}, fmt.Errorf("%w: candidate action-map binding is stale", ErrConflict)
	}
	var metadata safeRevisionMetadata
	if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil {
		return EvidenceResolution{}, fmt.Errorf("decode candidate evidence metadata: %w", err)
	}
	list, err := manifest.DecodeActionList(json.RawMessage(candidateJSON))
	if err != nil {
		return EvidenceResolution{}, fmt.Errorf("decode candidate evidence document: %w", err)
	}

	entities := make(map[string]bool)
	for _, entity := range metadata.Entities {
		for _, handle := range entity.EvidenceHandles {
			if handle == referenceID || strings.HasSuffix(handle, ":"+referenceID) {
				entities[entity.EntityKind+":"+entity.EntityID] = true
			}
		}
	}
	for _, action := range list.Actions {
		matched := false
		for _, traceID := range action.Provenance.TraceIDs {
			matched = matched || traceID == referenceID
		}
		for _, step := range action.Steps {
			for _, evidence := range step.Evidence {
				matched = matched || evidence.TraceID == referenceID || evidence.TransitionID == referenceID
			}
		}
		if matched {
			entities["action:"+action.ID] = true
		}
	}

	matches := make([]EvidenceResolutionHit, 0)
	for _, item := range metadata.Bindings {
		if item.EvidenceID != referenceID && !entities[item.EntityKind+":"+item.EntityID] {
			continue
		}
		matches = append(matches, EvidenceResolutionHit{
			EntityKind: item.EntityKind, EntityID: item.EntityID, Provenance: item.Provenance,
			LayerSequence: item.LayerSequence, LayerID: item.LayerID, EvidenceID: item.EvidenceID,
			ContentDigest: item.ContentDigest, BindingRole: item.BindingRole,
			StepIndex: copyInt(item.StepIndex), FieldName: copyDigest(item.FieldName),
		})
	}
	if len(matches) == 0 {
		return EvidenceResolution{}, ErrNotFound
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].EntityID != matches[j].EntityID {
			return matches[i].EntityID < matches[j].EntityID
		}
		if matches[i].LayerSequence != matches[j].LayerSequence {
			return matches[i].LayerSequence < matches[j].LayerSequence
		}
		return matches[i].EvidenceID < matches[j].EvidenceID
	})
	return EvidenceResolution{
		SchemaVersion: "evidence-resolution/1", Binding: binding,
		ReferenceID: referenceID, Matches: matches,
	}, nil
}

func copyInt(value *int) *int {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}
