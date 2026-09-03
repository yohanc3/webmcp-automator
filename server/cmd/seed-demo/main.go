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

const listID = "owned_storefront_basket"
const revisionNumber = 2

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
	if existing, getErr := database.GetActionListRevision(ctx, listID, revisionNumber); getErr == nil && existing.Status == "published" {
		fmt.Printf("demo action list already published: %s revision %d %s\n", existing.ListID, existing.Revision, existing.Digest)
		return
	}

	path := filepath.Join("..", "documentation", "contracts", "examples", "owned-storefront-basket.action-list.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	revision, err := database.InsertActionListRevision(ctx, json.RawMessage(raw))
	if err != nil {
		if !errors.Is(err, store.ErrConflict) {
			log.Fatal(err)
		}
		revision, err = database.GetActionListRevision(ctx, listID, revisionNumber)
		if err != nil || revision.Status != "candidate" {
			log.Fatalf("load existing demo candidate: %v", err)
		}
	}

	suffix := time.Now().UTC().Format("20060102_150405_000000000")
	policyID := "policy_owned_demo_" + suffix
	replayID := "replay_owned_demo_" + suffix
	checkedAt := time.Now().UTC()
	if err := database.SavePolicyDecision(ctx, store.PolicyRecord{
		ID: policyID, ListID: listID, Revision: revisionNumber, CandidateDigest: revision.CandidateDigest,
		Decision: "allowed", Scopes: []string{"learn", "inject", "read", "write"}, CheckedAt: checkedAt,
	}); err != nil {
		log.Fatal(err)
	}
	report, _ := json.Marshal(map[string]any{
		"schemaVersion": "candidate-replay/1", "status": "passed",
		"actions": []map[string]any{{
			"actionId": "add_field_h1_to_basket", "actionVersion": 2,
			"stepsExecuted": 1, "postconditionsVerified": 1,
		}},
	})
	if err := database.SaveReplayReport(ctx, store.ReplayReport{
		ID: replayID, ListID: listID, Revision: revisionNumber, CandidateDigest: revision.CandidateDigest,
		Status: "passed", Report: report,
	}); err != nil {
		log.Fatal(err)
	}
	published, err := database.PublishActionList(ctx, listID, revisionNumber, store.PublishActionListRequest{
		ExpectedDigest: revision.CandidateDigest, ReviewDecision: "approve", Reviewer: "local-user",
		PolicyDecisionID: policyID, ReplayReportID: replayID,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("published demo action list: %s revision %d %s\n", published.ListID, published.Revision, published.Digest)
}
