package store

import (
	"testing"

	"webmcp-automator/server/internal/actionmap"
	"webmcp-automator/server/internal/manifest"
)

func TestRuntimeFeedbackScoresFailuresAndQuarantinesRepeatedDrift(t *testing.T) {
	code := "TARGET_NOT_FOUND"
	delta, target, postcondition := feedbackAdjustment(RunObservation{
		Status: "failed", ErrorCode: &code,
	})
	if delta != -0.2 || !target || postcondition {
		t.Fatalf("unexpected target feedback: %v %v %v", delta, target, postcondition)
	}
	if health := feedbackHealth(1, 3, 3, 0); health != "quarantined" {
		t.Fatalf("expected quarantine, got %s", health)
	}
	if health := feedbackHealth(4, 1, 1, 0); health != "degraded" {
		t.Fatalf("expected degradation, got %s", health)
	}
}

func TestRuntimeFeedbackConvertsAProvenFallbackIntoAStableMapLocator(t *testing.T) {
	locator := actionMapLocator(manifest.LocatorStrategy{
		Kind: "css", Selector: "[data-product-id='field-h1'] button",
	})
	if locator.CSS == nil || *locator.CSS != "[data-product-id='field-h1'] button" ||
		locator.Role != nil || locator.Text != nil {
		t.Fatalf("unexpected repaired locator: %#v", locator)
	}
}

func TestRuntimeFeedbackPromotesTheFallbackUsedByTheDurableActor(t *testing.T) {
	primary, fallback := 0, 1
	action := actionmap.Action{Steps: []actionmap.Step{{
		Operation: "click",
		Target:    actionmap.Locator{Role: feedbackStringPointer("button"), Name: feedbackStringPointer("Add")},
	}}}
	published := manifest.Action{Steps: []manifest.ActionStep{{
		ID: "add_product", Operation: "click", Target: &manifest.ActionLocator{Strategies: []manifest.LocatorStrategy{
			{Kind: "role", Role: "button", Name: "Add"},
			{Kind: "css", Selector: "[data-product-id='field-h1'] button"},
		}},
	}}}
	if repaired := repairActionLocators(&action, published, []ObservationStep{{
		StepID: "add_product", LocatorStrategyIndex: &primary,
	}}); repaired {
		t.Fatal("primary locator use must not produce a repair")
	}
	if repaired := repairActionLocators(&action, published, []ObservationStep{{
		StepID: "add_product", LocatorStrategyIndex: &fallback,
	}}); !repaired || action.Steps[0].Target.CSS == nil ||
		*action.Steps[0].Target.CSS != "[data-product-id='field-h1'] button" {
		t.Fatalf("fallback was not promoted: %#v", action.Steps[0].Target)
	}
}
