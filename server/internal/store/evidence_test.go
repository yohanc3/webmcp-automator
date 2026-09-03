package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestResolveCandidateEvidenceReturnsOnlyExactCurrentSafeBindings(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDatabase.Close()
	database := New(sqlDatabase)
	candidate, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "documentation", "contracts", "examples", "owned-storefront.action-list.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	digest := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	mapDigest := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	metadata := `{"entities":[{"entityKind":"action","entityId":"search_products","provenance":"observed","evidenceHandles":["node_search"]}],"evidence":[],"bindings":[{"entityKind":"action","entityId":"search_products","provenance":"observed","layerSequence":2,"layerId":"layer_search","evidenceId":"node_search","contentDigest":"` + mapDigest + `","bindingRole":"target","stepIndex":0,"fieldName":null}]}`
	mock.ExpectQuery("SELECT bindings.candidate_digest").
		WithArgs("owned_storefront", 1).
		WillReturnRows(sqlmock.NewRows([]string{
			"candidate_digest", "scope_id", "action_map_revision", "action_map_digest",
			"stored_candidate_digest", "head_revision", "head_digest", "stored_map_digest", "evidence_metadata_json", "document_json",
		}).AddRow(digest, "owned_storefront", 1, mapDigest, digest, 1, mapDigest, mapDigest, metadata, string(candidate)))

	resolution, err := database.ResolveCandidateEvidence(
		context.Background(), "owned_storefront", 1, "transition_1",
	)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Binding.ActionMapDigest != mapDigest || len(resolution.Matches) != 1 ||
		resolution.Matches[0].EvidenceID != "node_search" ||
		resolution.Matches[0].ContentDigest != mapDigest {
		t.Fatalf("unexpected evidence resolution: %#v", resolution)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestResolveCandidateEvidenceRejectsAMismatchedStoredMapDigest(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDatabase.Close()
	digest := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	mapDigest := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	wrongDigest := "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	mock.ExpectQuery("SELECT bindings.candidate_digest").
		WithArgs("owned_storefront", 1).
		WillReturnRows(sqlmock.NewRows([]string{
			"candidate_digest", "scope_id", "action_map_revision", "action_map_digest",
			"stored_candidate_digest", "head_revision", "head_digest", "stored_map_digest", "evidence_metadata_json", "document_json",
		}).AddRow(digest, "owned_storefront", 1, mapDigest, digest, 1, mapDigest, wrongDigest, `{}`, `{}`))

	_, err = New(sqlDatabase).ResolveCandidateEvidence(context.Background(), "owned_storefront", 1, "transition_1")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected exact digest conflict, got %v", err)
	}
}
