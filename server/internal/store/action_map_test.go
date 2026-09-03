package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestMemoryActionMapStoreAppliesOrdersRevisionsAndProjectsCompactContext(t *testing.T) {
	database := NewMemoryActionMapStore()
	first := ordersApplication(t, "001")
	second := ordersApplication(t, "002")

	firstReceipt, err := database.ApplyActionMapPatch(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, firstReceipt, "applied", "", 1,
		"sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492")
	firstRevision, err := database.GetActionMapRevision(context.Background(), "owned_account_orders", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstRevision.ActionMap.States) != 1 || len(firstRevision.ActionMap.Actions) != 1 ||
		firstRevision.ActionMap.Actions[0].ID != "open_orders" {
		t.Fatalf("unexpected first action map: %#v", firstRevision.ActionMap)
	}

	secondReceipt, err := database.ApplyActionMapPatch(context.Background(), second)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, secondReceipt, "applied", "", 2,
		"sha256:56595101ceb38ae2ca89a1133a2e78f975ba19048beeee36a1bc2f6bd9cbdb42")
	head, err := database.GetActionMapHead(context.Background(), "owned_account_orders")
	if err != nil {
		t.Fatal(err)
	}
	if head.Revision != 2 || head.SourceLayerSequence != 2 || len(head.ActionMap.Actions) != 3 {
		t.Fatalf("unexpected head: %#v", head)
	}
	if !sort.SliceIsSorted(head.ActionMap.Actions, func(i, j int) bool {
		return head.ActionMap.Actions[i].ID < head.ActionMap.Actions[j].ID
	}) {
		t.Fatal("materialized actions are not canonically ordered")
	}
	immutableFirst, err := database.GetActionMapRevision(context.Background(), "owned_account_orders", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(immutableFirst.ActionMap.Actions) != 1 || immutableFirst.ActionMap.Actions[0].Status != "resolvable" {
		t.Fatalf("revision 1 changed after revision 2 was appended: %#v", immutableFirst.ActionMap)
	}

	contextProjection, err := database.GetActionMapContext(
		context.Background(), "owned_account_orders", 2,
	)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(contextProjection)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		`"steps"`, `"target"`, `"locator"`, `"semanticXml"`, `"observation"`,
		`"literalValue"`, `"observedUrls"`, `"argumentTokens"`, `"prompt"`,
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("compact context contains forbidden material %s: %s", forbidden, encoded)
		}
	}
	if len(contextProjection.Actions) != 3 ||
		contextProjection.Actions[0].ActionID != "get_orders_from_account" ||
		contextProjection.Actions[0].Provenance != "observed" {
		t.Fatalf("unexpected compact actions: %#v", contextProjection.Actions)
	}
}

func TestMemoryActionMapStoreDuplicateNoChangeAndReusedKey(t *testing.T) {
	database := NewMemoryActionMapStore()
	first := ordersApplication(t, "001")
	original, err := database.ApplyActionMapPatch(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	retry := first
	retry.Request.Attempt++
	duplicate, err := database.ApplyActionMapPatch(context.Background(), retry)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.Application.Status != "duplicate" ||
		!duplicate.AppliedAt.Equal(original.AppliedAt) ||
		database.ActionMapRevisionCount("owned_account_orders") != 1 {
		t.Fatalf("duplicate did not preserve the original receipt/revision: %#v", duplicate)
	}

	reused := first
	reused.Patch.Summary = "Changed input under the same idempotency key."
	rejected, err := database.ApplyActionMapPatch(context.Background(), reused)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, rejected, "rejected", "IDEMPOTENCY_KEY_REUSED", 0, "")

	noChange := ordersApplication(t, "002")
	noChange.Patch.Decision = "no_change"
	noChange.Patch.Summary = "The layer is already represented."
	noChange.Patch.Operations = []PatchOperation{}
	receipt, err := database.ApplyActionMapPatch(context.Background(), noChange)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, receipt, "no_change", "", 1,
		"sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492")
	if database.ActionMapRevisionCount("owned_account_orders") != 1 {
		t.Fatal("no_change appended an action map revision")
	}
	head, err := database.GetActionMapHead(context.Background(), "owned_account_orders")
	if err != nil || head.Revision != 1 || head.SourceLayerSequence != 2 {
		t.Fatalf("no_change did not advance the memory head layer sequence: %#v, %v", head, err)
	}
	compact, err := database.GetActionMapContext(context.Background(), "owned_account_orders", 1)
	if err != nil || compact.Revision != 1 || compact.SourceLayerSequence != 2 {
		t.Fatalf("no_change did not preserve the memory context layer sequence: %#v, %v", compact, err)
	}

	noChangeRetry := noChange
	noChangeRetry.Request.Attempt++
	noChangeDuplicate, err := database.ApplyActionMapPatch(context.Background(), noChangeRetry)
	if err != nil || noChangeDuplicate.Application.Status != "duplicate" {
		t.Fatalf("no_change duplicate was not idempotent: %#v, %v", noChangeDuplicate, err)
	}

	staleLayer := first
	staleLayer.Request.RequestID = "parse_orders_stale_after_no_change"
	staleLayer.Patch.RequestID = staleLayer.Request.RequestID
	staleLayer.Patch.PatchID = "patch_orders_stale_after_no_change"
	digest := "sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492"
	staleLayer.Request.MapBase = MapBase{Revision: 1, Digest: &digest, PreviousLayerSequence: 2}
	staleLayer.Patch.MapBase = PatchMapBase{Revision: 1, Digest: &digest}
	setApplicationIdempotencyKey(t, &staleLayer)
	staleReceipt, err := database.ApplyActionMapPatch(context.Background(), staleLayer)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, staleReceipt, "conflict", "LAYER_SEQUENCE_STALE", 0, "")

	conflict := ordersApplication(t, "002")
	conflict.Request.Layer.Sequence = 3
	conflict.Request.Layer.URL = "https://shop.example/orders?conflict=stale"
	conflict.Patch.LayerSequence = 3
	setApplicationIdempotencyKey(t, &conflict)
	conflictReceipt, err := database.ApplyActionMapPatch(context.Background(), conflict)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, conflictReceipt, "conflict", "LAYER_SEQUENCE_STALE", 0, "")
	head, err = database.GetActionMapHead(context.Background(), "owned_account_orders")
	if err != nil || head.SourceLayerSequence != 2 {
		t.Fatalf("conflict advanced the memory head layer sequence: %#v, %v", head, err)
	}

	third := relayerApplication(t, ordersApplication(t, "002"), "layer_orders_002", "layer_orders_003")
	third.Request.Layer.Sequence = 3
	third.Patch.LayerSequence = 3
	third.Request.MapBase.PreviousLayerSequence = 2
	setApplicationIdempotencyKey(t, &third)
	if err := validateApplicationInput(third, head, database.scopes["owned_account_orders"].metadata); err != nil {
		t.Fatalf("layer 3 fixture is invalid: %v", err)
	}
	if _, _, err := applyPatch(third, head.ActionMap, database.scopes["owned_account_orders"].metadata); err != nil {
		t.Fatalf("layer 3 patch cannot materialize: %v", err)
	}
	thirdReceipt, err := database.ApplyActionMapPatch(context.Background(), third)
	if err != nil {
		t.Fatal(err)
	}
	if thirdReceipt.Application.Status != "applied" || thirdReceipt.Application.Result == nil ||
		thirdReceipt.Application.Result.Revision != 2 {
		t.Fatalf("layer 3 did not append revision 2: %#v", thirdReceipt)
	}
}

func TestMemoryActionMapStoreRejectsStaleBaseAndLayer(t *testing.T) {
	database := NewMemoryActionMapStore()
	first := ordersApplication(t, "001")
	if _, err := database.ApplyActionMapPatch(context.Background(), first); err != nil {
		t.Fatal(err)
	}

	staleBase := first
	staleBase.Request.RequestID = "parse_orders_stale_base"
	staleBase.Patch.RequestID = staleBase.Request.RequestID
	staleBase.Patch.PatchID = "patch_orders_stale_base"
	staleBase.Request.Layer.URL = "https://shop.example/account?retry=stale"
	setApplicationIdempotencyKey(t, &staleBase)
	receipt, err := database.ApplyActionMapPatch(context.Background(), staleBase)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, receipt, "conflict", "BASE_REVISION_STALE", 0, "")

	staleLayer := first
	staleLayer.Request.RequestID = "parse_orders_stale_layer"
	staleLayer.Patch.RequestID = staleLayer.Request.RequestID
	staleLayer.Patch.PatchID = "patch_orders_stale_layer"
	digest := "sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492"
	staleLayer.Request.MapBase = MapBase{Revision: 1, Digest: &digest, PreviousLayerSequence: 1}
	staleLayer.Patch.MapBase = PatchMapBase{Revision: 1, Digest: &digest}
	setApplicationIdempotencyKey(t, &staleLayer)
	receipt, err = database.ApplyActionMapPatch(context.Background(), staleLayer)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, receipt, "conflict", "LAYER_SEQUENCE_STALE", 0, "")

	staleDigest := ordersApplication(t, "002")
	wrongDigest := "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	staleDigest.Request.MapBase.Digest = &wrongDigest
	staleDigest.Patch.MapBase.Digest = &wrongDigest
	setApplicationIdempotencyKey(t, &staleDigest)
	receipt, err = database.ApplyActionMapPatch(context.Background(), staleDigest)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, receipt, "conflict", "BASE_DIGEST_MISMATCH", 0, "")
}

func TestMemoryActionMapStoreConcurrentPatchesHaveOneWinner(t *testing.T) {
	database := NewMemoryActionMapStore()
	left := ordersApplication(t, "001")
	right := ordersApplication(t, "001")
	right.Request.RequestID = "parse_orders_concurrent"
	right.Patch.RequestID = right.Request.RequestID
	right.Patch.PatchID = "patch_orders_concurrent"
	right.Request.Layer.URL = "https://shop.example/account?view=compact"
	setApplicationIdempotencyKey(t, &right)

	inputs := []ApplyActionMapRequest{left, right}
	results := make(chan ActionMapReceipt, 2)
	var wait sync.WaitGroup
	for _, input := range inputs {
		wait.Add(1)
		go func(application ApplyActionMapRequest) {
			defer wait.Done()
			receipt, err := database.ApplyActionMapPatch(context.Background(), application)
			if err != nil {
				t.Errorf("apply concurrent patch: %v", err)
				return
			}
			results <- receipt
		}(input)
	}
	wait.Wait()
	close(results)
	statuses := make(map[string]int)
	for result := range results {
		statuses[result.Application.Status]++
	}
	if statuses["applied"] != 1 || statuses["conflict"] != 1 ||
		database.ActionMapRevisionCount("owned_account_orders") != 1 {
		t.Fatalf("unexpected concurrent outcomes: %#v", statuses)
	}
	head, err := database.GetActionMapHead(context.Background(), "owned_account_orders")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(head.ActionMap.Site.ObservedURLs[0], "?") ||
		strings.Contains(head.ActionMap.Site.ObservedURLs[0], "#") {
		t.Fatalf("stored observed URL retained private query or fragment: %s", head.ActionMap.Site.ObservedURLs[0])
	}
}

func TestMemoryActionMapStoreRejectsPrivateOrLiteralMaterial(t *testing.T) {
	for name, mutate := range map[string]func(*ApplyActionMapRequest){
		"literal typed value": func(input *ApplyActionMapRequest) {
			value := "private@example.com"
			input.Patch.Operations[1].Action.Steps[0].LiteralValue = &value
		},
		"private page text": func(input *ApplyActionMapRequest) {
			input.Patch.Operations[1].Action.Description = "Open orders for private@example.com"
		},
		"URL query": func(input *ApplyActionMapRequest) {
			input.Patch.Operations[1].Action.Description = "https://shop.example/orders?account=private"
		},
	} {
		t.Run(name, func(t *testing.T) {
			database := NewMemoryActionMapStore()
			input := ordersApplication(t, "001")
			mutate(&input)
			receipt, err := database.ApplyActionMapPatch(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			assertReceipt(t, receipt, "rejected", "VALIDATION_FAILED", 0, "")
			if database.ActionMapRevisionCount("owned_account_orders") != 0 {
				t.Fatal("rejected input created a revision")
			}
		})
	}
}

func TestSQLActionMapStoreAppendsCanonicalRevision(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := New(sqlDatabase)
	defer database.Close()
	input := ordersApplication(t, "001")
	routesJSON, _ := canonicalJSON(input.Request.SiteScope.RoutePatterns)

	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO action_map_scopes").
		WithArgs("owned_account_orders", "https://shop.example", string(routesJSON), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"scope_id"}).AddRow("owned_account_orders"))
	mock.ExpectQuery("SELECT origin, route_patterns_json, head_revision").
		WithArgs("owned_account_orders").
		WillReturnRows(sqlmock.NewRows([]string{
			"origin", "route_patterns_json", "head_revision", "head_digest", "last_layer_sequence",
		}).AddRow("https://shop.example", string(routesJSON), 0, nil, 0))
	mock.ExpectQuery("SELECT input_digest, receipt_json").
		WithArgs("owned_account_orders", input.Request.IdempotencyKey).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectExec("INSERT INTO action_map_revisions").
		WithArgs(
			"owned_account_orders", 1,
			"sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492",
			1, "action-map/1", sqlmock.AnyArg(), sqlmock.AnyArg(), "ambient_action_parser",
			"1.0.0", "ambient-v1", sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE action_map_scopes").
		WithArgs(
			1, "sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492",
			1, sqlmock.AnyArg(), "owned_account_orders",
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO action_map_receipts").
		WithArgs(
			"owned_account_orders", input.Request.IdempotencyKey, sqlmock.AnyArg(), 1,
			sqlmock.AnyArg(), sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	receipt, err := database.ApplyActionMapPatch(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, receipt, "applied", "", 1,
		"sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492")
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}

	firstPrepared := prepareActionMapApplication(
		input,
		seedActionMap(input.Request.SiteScope),
		safeRevisionMetadata{
			Entities: []safeEntityMetadata{}, Evidence: []EvidenceCitation{}, Bindings: []safeEvidenceBinding{},
		},
		time.Now().UTC(),
	)
	firstMapJSON, _ := canonicalJSON(firstPrepared.snapshot.ActionMap)
	firstMetadataJSON, _ := canonicalJSON(firstPrepared.metadata)
	second := ordersApplication(t, "002")
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO action_map_scopes").
		WithArgs("owned_account_orders", "https://shop.example", string(routesJSON), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"scope_id"}))
	mock.ExpectQuery("SELECT origin, route_patterns_json, head_revision").
		WithArgs("owned_account_orders").
		WillReturnRows(sqlmock.NewRows([]string{
			"origin", "route_patterns_json", "head_revision", "head_digest", "last_layer_sequence",
		}).AddRow(
			"https://shop.example", string(routesJSON), 1,
			"sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492", 1,
		))
	mock.ExpectQuery("SELECT scope_id, revision, digest, source_layer_sequence").
		WithArgs("owned_account_orders", 1).
		WillReturnRows(sqlmock.NewRows([]string{
			"scope_id", "revision", "digest", "source_layer_sequence", "document_json",
			"evidence_metadata_json", "created_at",
		}).AddRow(
			"owned_account_orders", 1,
			"sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492",
			1, string(firstMapJSON), string(firstMetadataJSON), time.Now().UTC(),
		))
	mock.ExpectQuery("SELECT input_digest, receipt_json").
		WithArgs("owned_account_orders", second.Request.IdempotencyKey).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectExec("INSERT INTO action_map_revisions").
		WithArgs(
			"owned_account_orders", 2,
			"sha256:56595101ceb38ae2ca89a1133a2e78f975ba19048beeee36a1bc2f6bd9cbdb42",
			2, "action-map/1", sqlmock.AnyArg(), sqlmock.AnyArg(), "ambient_action_parser",
			"1.0.0", "ambient-v1", sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE action_map_scopes").
		WithArgs(
			2, "sha256:56595101ceb38ae2ca89a1133a2e78f975ba19048beeee36a1bc2f6bd9cbdb42",
			2, sqlmock.AnyArg(), "owned_account_orders",
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO action_map_receipts").
		WithArgs(
			"owned_account_orders", second.Request.IdempotencyKey, sqlmock.AnyArg(), 2,
			sqlmock.AnyArg(), sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	secondReceipt, err := database.ApplyActionMapPatch(context.Background(), second)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, secondReceipt, "applied", "", 2,
		"sha256:56595101ceb38ae2ca89a1133a2e78f975ba19048beeee36a1bc2f6bd9cbdb42")
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSafeEvidenceMetadataContainsOnlyAllowlistedBindings(t *testing.T) {
	first := ordersApplication(t, "001")
	prepared := prepareActionMapApplication(
		first,
		seedActionMap(first.Request.SiteScope),
		safeRevisionMetadata{
			Entities: []safeEntityMetadata{}, Evidence: []EvidenceCitation{}, Bindings: []safeEvidenceBinding{},
		},
		time.Now().UTC(),
	)
	encoded, err := canonicalJSON(prepared.metadata)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{`"bindingRole"`, `"contentDigest"`, `"layerSequence"`, `"evidenceId"`} {
		if !strings.Contains(string(encoded), required) {
			t.Fatalf("safe evidence metadata omits %s: %s", required, encoded)
		}
	}
	for _, forbidden := range []string{"<semantic-ui", "https://shop.example/account", "Orders page semantic link"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("safe evidence metadata contains source material %q", forbidden)
		}
	}
}

func TestSQLActionMapStoreReadsExactHeadRevisionAndContext(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := New(sqlDatabase)
	defer database.Close()
	input := ordersApplication(t, "001")
	prepared := prepareActionMapApplication(
		input,
		seedActionMap(input.Request.SiteScope),
		safeRevisionMetadata{
			Entities: []safeEntityMetadata{}, Evidence: []EvidenceCitation{}, Bindings: []safeEvidenceBinding{},
		},
		time.Now().UTC(),
	)
	mapJSON, _ := canonicalJSON(prepared.snapshot.ActionMap)
	metadataJSON, _ := canonicalJSON(prepared.metadata)
	routesJSON, _ := canonicalJSON(input.Request.SiteScope.RoutePatterns)
	createdAt := time.Now().UTC()
	digest := *prepared.snapshot.Digest
	revisionRows := func(includeMetadata bool) *sqlmock.Rows {
		columns := []string{
			"scope_id", "revision", "digest", "source_layer_sequence", "document_json", "created_at",
		}
		values := []driver.Value{"owned_account_orders", 1, digest, 1, string(mapJSON), createdAt}
		if includeMetadata {
			columns = []string{
				"scope_id", "revision", "digest", "source_layer_sequence", "document_json",
				"evidence_metadata_json", "created_at",
			}
			values = []driver.Value{
				"owned_account_orders", 1, digest, 1, string(mapJSON), string(metadataJSON), createdAt,
			}
		}
		return sqlmock.NewRows(columns).AddRow(values...)
	}

	mock.ExpectQuery("SELECT scope_id, origin, route_patterns_json, head_revision").
		WithArgs("owned_account_orders").
		WillReturnRows(sqlmock.NewRows([]string{
			"scope_id", "origin", "route_patterns_json", "head_revision", "head_digest", "last_layer_sequence",
		}).AddRow("owned_account_orders", "https://shop.example", string(routesJSON), 1, digest, 2))
	mock.ExpectQuery("SELECT scope_id, revision, digest, source_layer_sequence").
		WithArgs("owned_account_orders", 1).
		WillReturnRows(revisionRows(true))
	head, err := database.GetActionMapHead(context.Background(), "owned_account_orders")
	if err != nil || head.Revision != 1 || head.SourceLayerSequence != 2 || head.Digest == nil || *head.Digest != digest {
		t.Fatalf("unexpected SQL head: %#v, %v", head, err)
	}

	mock.ExpectQuery("SELECT scope_id, revision, digest, source_layer_sequence").
		WithArgs("owned_account_orders", 1).
		WillReturnRows(revisionRows(false))
	revision, err := database.GetActionMapRevision(context.Background(), "owned_account_orders", 1)
	if err != nil || revision.Revision != 1 || len(revision.ActionMap.Actions) != 1 {
		t.Fatalf("unexpected SQL revision: %#v, %v", revision, err)
	}

	mock.ExpectQuery("SELECT action_map_revisions.scope_id, action_map_revisions.revision").
		WithArgs("owned_account_orders", 1).
		WillReturnRows(sqlmock.NewRows([]string{
			"scope_id", "revision", "digest", "source_layer_sequence", "document_json",
			"evidence_metadata_json", "created_at", "head_revision", "last_layer_sequence",
		}).AddRow("owned_account_orders", 1, digest, 1, string(mapJSON), string(metadataJSON), createdAt, 1, 2))
	compact, err := database.GetActionMapContext(context.Background(), "owned_account_orders", 1)
	if err != nil || compact.Revision != 1 || compact.SourceLayerSequence != 2 || len(compact.Actions) != 1 ||
		compact.Actions[0].ActionID != "open_orders" {
		t.Fatalf("unexpected SQL compact context: %#v, %v", compact, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSQLActionMapStoreAdvancesScopeSequenceForNoChange(t *testing.T) {
	sqlDatabase, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	database := New(sqlDatabase)
	defer database.Close()

	first := ordersApplication(t, "001")
	firstPrepared := prepareActionMapApplication(
		first,
		seedActionMap(first.Request.SiteScope),
		safeRevisionMetadata{
			Entities: []safeEntityMetadata{}, Evidence: []EvidenceCitation{}, Bindings: []safeEvidenceBinding{},
		},
		time.Now().UTC(),
	)
	mapJSON, _ := canonicalJSON(firstPrepared.snapshot.ActionMap)
	metadataJSON, _ := canonicalJSON(firstPrepared.metadata)
	routesJSON, _ := canonicalJSON(first.Request.SiteScope.RoutePatterns)
	digest := *firstPrepared.snapshot.Digest
	noChange := ordersApplication(t, "002")
	noChange.Patch.Decision = "no_change"
	noChange.Patch.Summary = "The layer is already represented."
	noChange.Patch.Operations = []PatchOperation{}

	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO action_map_scopes").
		WithArgs("owned_account_orders", "https://shop.example", string(routesJSON), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"scope_id"}))
	mock.ExpectQuery("SELECT origin, route_patterns_json, head_revision").
		WithArgs("owned_account_orders").
		WillReturnRows(sqlmock.NewRows([]string{
			"origin", "route_patterns_json", "head_revision", "head_digest", "last_layer_sequence",
		}).AddRow("https://shop.example", string(routesJSON), 1, digest, 1))
	mock.ExpectQuery("SELECT scope_id, revision, digest, source_layer_sequence").
		WithArgs("owned_account_orders", 1).
		WillReturnRows(sqlmock.NewRows([]string{
			"scope_id", "revision", "digest", "source_layer_sequence", "document_json",
			"evidence_metadata_json", "created_at",
		}).AddRow("owned_account_orders", 1, digest, 1, string(mapJSON), string(metadataJSON), time.Now().UTC()))
	mock.ExpectQuery("SELECT input_digest, receipt_json").
		WithArgs("owned_account_orders", noChange.Request.IdempotencyKey).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectExec("UPDATE action_map_scopes").
		WithArgs(1, digest, 2, sqlmock.AnyArg(), "owned_account_orders").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO action_map_receipts").
		WithArgs("owned_account_orders", noChange.Request.IdempotencyKey, sqlmock.AnyArg(), 2,
			sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	receipt, err := database.ApplyActionMapPatch(context.Background(), noChange)
	if err != nil {
		t.Fatal(err)
	}
	assertReceipt(t, receipt, "no_change", "", 1, digest)
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestActionMapSchemaUsesStrictSafeStorageAllowlist(t *testing.T) {
	forbidden := []string{
		"semantic_xml", "observation_json", "event_json", "prompt_body", "model_response",
		"typed_value", "page_text", "browsing_history", "raw_html", "screenshot",
	}
	lowerSchema := strings.ToLower(schemaSQL)
	ambientStart := strings.Index(lowerSchema, "create table if not exists action_map_scopes")
	ambientEnd := strings.Index(lowerSchema[ambientStart:], "-- action_lists")
	if ambientStart < 0 || ambientEnd < 0 {
		t.Fatal("ambient action-map storage tables are missing")
	}
	ambientSchema := lowerSchema[ambientStart : ambientStart+ambientEnd]
	for _, field := range forbidden {
		if regexp.MustCompile(`\b` + regexp.QuoteMeta(field) + `\b`).MatchString(ambientSchema) {
			t.Fatalf("forbidden durable storage field %q is present", field)
		}
	}
	for _, required := range []string{
		"digest", "source_layer_sequence", "evidence_metadata_json", "parser_version",
		"idempotency_key", "input_digest",
	} {
		if !strings.Contains(ambientSchema, required) {
			t.Fatalf("safe storage field %q is missing", required)
		}
	}
}

func ordersApplication(t *testing.T, layer string) ApplyActionMapRequest {
	t.Helper()
	var request AmbientParseRequest
	readFixture(t, "orders.layer-"+layer+".parse-request.json", &request)
	var patch ActionMapPatch
	readFixture(t, "orders.layer-"+layer+".patch.json", &patch)
	return ApplyActionMapRequest{Request: request, Patch: patch}
}

func readFixture(t *testing.T, name string, target any) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "documentation", "contracts", "examples", name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatal(err)
	}
}

func setApplicationIdempotencyKey(t *testing.T, input *ApplyActionMapRequest) {
	t.Helper()
	digest, err := ambientIdempotencyDigest(input.Request)
	if err != nil {
		t.Fatal(err)
	}
	input.Request.IdempotencyKey = digest
	input.Patch.IdempotencyKey = digest
}

func relayerApplication(t *testing.T, input ApplyActionMapRequest, from, to string) ApplyActionMapRequest {
	t.Helper()
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(encoded), from, to)), &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func assertReceipt(
	t *testing.T,
	receipt ActionMapReceipt,
	status string,
	code string,
	revision int,
	digest string,
) {
	t.Helper()
	if receipt.Application.Status != status {
		t.Fatalf("expected status %s, got %#v", status, receipt.Application)
	}
	if code == "" {
		if receipt.Application.ConflictCode != nil {
			t.Fatalf("unexpected conflict code: %s", *receipt.Application.ConflictCode)
		}
	} else if receipt.Application.ConflictCode == nil || *receipt.Application.ConflictCode != code {
		t.Fatalf("expected conflict code %s, got %#v", code, receipt.Application.ConflictCode)
	}
	if revision > 0 {
		if receipt.Application.Result == nil || receipt.Application.Result.Revision != revision ||
			receipt.Application.Result.Digest == nil || *receipt.Application.Result.Digest != digest {
			t.Fatalf("unexpected receipt result: %#v", receipt.Application.Result)
		}
	}
}

func TestCanonicalJSONMatchesFrozenRequestAndMapDigests(t *testing.T) {
	input := ordersApplication(t, "001")
	requestDigest, err := ambientIdempotencyDigest(input.Request)
	if err != nil {
		t.Fatal(err)
	}
	if requestDigest != input.Request.IdempotencyKey {
		t.Fatalf("canonical request digest mismatch: %s", requestDigest)
	}
	prepared := prepareActionMapApplication(
		input,
		seedActionMap(input.Request.SiteScope),
		safeRevisionMetadata{
			Entities: []safeEntityMetadata{}, Evidence: []EvidenceCitation{}, Bindings: []safeEvidenceBinding{},
		},
		time.Date(2026, 9, 3, 12, 10, 1, 0, time.UTC),
	)
	if prepared.snapshot.Digest == nil ||
		*prepared.snapshot.Digest != "sha256:20fd07cfcf35702ec55664cb488e5928e4684bbb959d52efeae495dd12117492" {
		t.Fatalf("canonical map digest mismatch: %#v", prepared.snapshot.Digest)
	}
	var expectedFirst ActionMapReceipt
	readFixture(t, "orders.layer-001.revision.json", &expectedFirst)
	if !reflect.DeepEqual(prepared.receipt, expectedFirst) {
		t.Fatalf("revision 1 receipt differs from frozen fixture:\nactual: %#v\nexpected: %#v", prepared.receipt, expectedFirst)
	}

	second := ordersApplication(t, "002")
	preparedSecond := prepareActionMapApplication(
		second,
		prepared.snapshot,
		prepared.metadata,
		time.Date(2026, 9, 3, 12, 10, 6, 0, time.UTC),
	)
	var expectedSecond ActionMapReceipt
	readFixture(t, "orders.layer-002.revision.json", &expectedSecond)
	if !reflect.DeepEqual(preparedSecond.receipt, expectedSecond) {
		t.Fatalf("revision 2 receipt differs from frozen fixture:\nactual: %#v\nexpected: %#v", preparedSecond.receipt, expectedSecond)
	}
}
