package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"webmcp-automator/server/internal/config"
	"webmcp-automator/server/internal/store"
)

type fixture struct {
	actionID      string
	actionVersion int
	filename      string
	listID        string
	revision      int
	steps         int
}

var fixtures = []fixture{
	{
		actionID: "search_products", actionVersion: 1,
		filename: "owned-storefront.action-list.json", listID: "owned_storefront",
		revision: 1, steps: 4,
	},
	{
		actionID: "add_field_h1_to_basket", actionVersion: 2,
		filename: "owned-storefront-basket.action-list.json", listID: "owned_storefront_basket",
		revision: 2, steps: 1,
	},
}

func main() {
	if err := config.LoadDotEnv(".env"); err != nil {
		log.Fatal(err)
	}
	database, err := store.Open(os.Getenv("DB_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer database.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, item := range fixtures {
		if err := seedFixture(ctx, database, item); err != nil {
			log.Fatal(err)
		}
	}
}

func seedFixture(ctx context.Context, database *store.Store, item fixture) error {
	if existing, err := database.GetActionListRevision(ctx, item.listID, item.revision); err == nil && existing.Status == "published" {
		fmt.Printf("demo action list already published: %s revision %d %s\n", existing.ListID, existing.Revision, existing.Digest)
		return nil
	}

	path := filepath.Join("..", "documentation", "contracts", "examples", item.filename)
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	revision, err := database.InsertActionListRevision(ctx, json.RawMessage(raw))
	if err != nil {
		if !errors.Is(err, store.ErrConflict) {
			return err
		}
		revision, err = database.GetActionListRevision(ctx, item.listID, item.revision)
		if err != nil {
			return fmt.Errorf("load existing demo candidate: %w", err)
		}
		if revision.Status != "candidate" {
			return fmt.Errorf("existing demo revision has status %q", revision.Status)
		}
	}

	suffix := time.Now().UTC().Format("20060102_150405_000000000")
	policyID := "policy_" + item.listID + "_" + suffix
	replayID := "replay_" + item.listID + "_" + suffix
	checkedAt := time.Now().UTC()
	if err := database.SavePolicyDecision(ctx, store.PolicyRecord{
		ID: policyID, ListID: item.listID, Revision: item.revision, CandidateDigest: revision.CandidateDigest,
		Decision: "allowed", Scopes: []string{"learn", "inject", "read", "write"}, CheckedAt: checkedAt,
	}); err != nil {
		return err
	}
	report, _ := json.Marshal(map[string]any{
		"schemaVersion": "candidate-replay/1", "status": "passed",
		"actions": []map[string]any{{
			"actionId": item.actionID, "actionVersion": item.actionVersion,
			"stepsExecuted": item.steps, "postconditionsVerified": item.steps,
		}},
	})
	if err := database.SaveReplayReport(ctx, store.ReplayReport{
		ID: replayID, ListID: item.listID, Revision: item.revision, CandidateDigest: revision.CandidateDigest,
		Status: "passed", Report: report,
	}); err != nil {
		return err
	}
	published, err := database.PublishActionList(ctx, item.listID, item.revision, store.PublishActionListRequest{
		ExpectedDigest: revision.CandidateDigest, ReviewDecision: "approve", Reviewer: "local-user",
		PolicyDecisionID: policyID, ReplayReportID: replayID,
	})
	if err != nil {
		return err
	}
	fmt.Printf("published demo action list: %s revision %d %s\n", published.ListID, published.Revision, published.Digest)
	return nil
}
