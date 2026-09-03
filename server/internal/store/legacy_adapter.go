package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"webmcp-automator/server/internal/manifest"
)

// legacyAdapters projects the canonical registry into learned-adapter/1 for
// the temporary /api/adapters caller. It never reads or writes legacy tables.
func legacyAdapters(revisions []ActionListRevision) ([]PublishedAdapter, error) {
	result := make([]PublishedAdapter, 0)
	for _, revision := range revisions {
		list, err := manifest.DecodeActionList(revision.Document)
		if err != nil {
			return nil, err
		}
		for _, action := range list.Actions {
			adapterID := list.ListID + "." + action.ID
			versionID := fmt.Sprintf("%s@%d@%s@%d", list.ListID, revision.Revision, action.ID, action.Version)
			result = append(result, PublishedAdapter{
				AdapterID: adapterID,
				VersionID: versionID,
				Version:   action.Version,
				Status:    "active",
				Manifest:  projectLegacyAdapter(list, action),
				CreatedAt: revision.CreatedAt,
			})
		}
	}
	return result, nil
}

func projectLegacyAdapter(list manifest.ActionList, action manifest.Action) manifest.Adapter {
	parameters := make([]manifest.Parameter, 0, len(action.Tool.InputSchema.Properties))
	parameterNames := make([]string, 0, len(action.Tool.InputSchema.Properties))
	for name := range action.Tool.InputSchema.Properties {
		parameterNames = append(parameterNames, name)
	}
	sort.Strings(parameterNames)
	for _, name := range parameterNames {
		property := action.Tool.InputSchema.Properties[name]
		propertyType := property.Type
		if propertyType == "integer" {
			propertyType = "number"
		}
		parameters = append(parameters, manifest.Parameter{
			Name: name, Description: property.Description, Type: propertyType,
			Required: containsString(action.Tool.InputSchema.Required, name),
		})
	}
	steps := make([]manifest.Step, 0, len(action.Steps))
	for _, actionStep := range action.Steps {
		step := manifest.Step{
			Operation: actionStep.Operation,
			TimeoutMS: actionStep.TimeoutMS,
		}
		if actionStep.Target != nil {
			step.Target = projectLegacyLocator(*actionStep.Target)
		}
		if actionStep.Value != nil {
			if actionStep.Value.FromArgument != "" {
				value := actionStep.Value.FromArgument
				step.ValueFrom = &value
			} else if actionStep.Value.Literal != nil {
				literal := fmt.Sprint(actionStep.Value.Literal)
				step.LiteralValue = &literal
			}
		}
		if actionStep.Key != "" {
			key := actionStep.Key
			step.Key = &key
		}
		for _, condition := range actionStep.Expect.Checks {
			if condition.Kind == "url" {
				step.ExpectNavigation = true
			}
		}
		steps = append(steps, step)
	}
	fields := make([]manifest.OutputField, 0, len(action.Output.Fields))
	for _, field := range action.Output.Fields {
		var attribute *string
		if field.Read != "text" {
			value := field.Read
			attribute = &value
		}
		fields = append(fields, manifest.OutputField{
			Name: field.Name, Locator: projectLegacyLocator(field.Locator),
			Attribute: attribute, Required: field.Required,
		})
	}
	limit := action.Output.Limit
	if limit == 0 {
		limit = 25
	}
	legacyCollectionRoot := manifest.Locator{}
	legacyItem := manifest.Locator{}
	legacyOutputMode := action.Output.Mode
	if legacyOutputMode == "none" {
		legacyOutputMode = "page"
	}
	if action.Output.CollectionRoot != nil {
		legacyCollectionRoot = projectLegacyLocator(*action.Output.CollectionRoot)
	}
	if action.Output.Item != nil {
		legacyItem = projectLegacyLocator(*action.Output.Item)
	}
	legacyRoutes := make([]string, 0, len(list.Site.RoutePatterns))
	for _, pattern := range list.Site.RoutePatterns {
		if strings.HasPrefix(pattern, "^/") {
			pattern = "^" + regexp.QuoteMeta(list.Site.Origin) + strings.TrimPrefix(pattern, "^")
		}
		legacyRoutes = append(legacyRoutes, pattern)
	}
	return manifest.Adapter{
		SchemaVersion: manifest.SchemaVersion,
		Usable:        true,
		Site: manifest.Site{
			Origin: list.Site.Origin, RoutePatterns: legacyRoutes,
		},
		Tool: manifest.Tool{
			Name: action.Tool.Name, Description: action.Tool.Description, Safety: action.Safety.Class,
			Parameters: parameters, Steps: steps,
			Output: manifest.Output{
				Mode: legacyOutputMode, CollectionRoot: legacyCollectionRoot,
				Item: legacyItem, Limit: limit, Fields: fields,
			},
			Annotations: manifest.Annotations{
				ReadOnlyHint:         action.Tool.Annotations.ReadOnlyHint,
				UntrustedContentHint: action.Tool.Annotations.UntrustedContentHint,
			},
		},
		Confidence: 1,
		Evidence:   strings.Join(action.Provenance.TraceIDs, ","),
	}
}

func projectLegacyLocator(locator manifest.ActionLocator) manifest.Locator {
	result := manifest.Locator{}
	if len(locator.Strategies) == 0 {
		return result
	}
	strategy := locator.Strategies[0]
	switch strategy.Kind {
	case "css":
		result.CSS = stringPointer(strategy.Selector)
	case "role":
		result.Role = stringPointer(strategy.Role)
		result.Name = stringPointer(strategy.Name)
	case "label":
		result.Name = stringPointer(strategy.Text)
	case "placeholder":
		result.Placeholder = stringPointer(strategy.Text)
	case "text":
		result.Text = stringPointer(strategy.Text)
	case "attribute":
		if strategy.Attribute == "id" {
			result.CSS = stringPointer("#" + strategy.Value)
		} else {
			result.CSS = stringPointer(fmt.Sprintf("[%s='%s']", strategy.Attribute, strategy.Value))
		}
	case "href":
		result.HrefContains = stringPointer(strategy.Contains)
	}
	return result
}

func parseLegacyVersionID(value string) (string, int, string, int, error) {
	parts := strings.Split(value, "@")
	if len(parts) != 4 {
		return "", 0, "", 0, errors.New("legacy versionId is not a registry projection")
	}
	revision, err := strconv.Atoi(parts[1])
	if err != nil || revision < 1 {
		return "", 0, "", 0, errors.New("legacy versionId has an invalid revision")
	}
	actionVersion, err := strconv.Atoi(parts[3])
	if err != nil || actionVersion < 1 {
		return "", 0, "", 0, errors.New("legacy versionId has an invalid action version")
	}
	return parts[0], revision, parts[2], actionVersion, nil
}

func (store *Store) recordLegacyRun(ctx context.Context, run Run) error {
	listID, revision, actionID, actionVersion, err := parseLegacyVersionID(run.VersionID)
	if err != nil {
		return err
	}
	stored, err := store.GetActionListRevision(ctx, listID, revision)
	if err != nil {
		return err
	}
	if stored.Status != "published" {
		return ErrNotFound
	}
	now := time.Now().UTC()
	status := "completed"
	if run.Outcome == "failure" {
		status = "failed"
	} else if run.Outcome != "success" {
		return errors.New("outcome must be success or failure")
	}
	return store.RecordRunObservation(ctx, RunObservation{
		SchemaVersion: "run-observation/1",
		RunID:         newID("legacy_run"),
		ListID:        listID,
		ListDigest:    stored.Digest,
		ActionID:      actionID,
		ActionVersion: actionVersion,
		StartedAt:     now.Format(time.RFC3339Nano),
		FinishedAt:    now.Format(time.RFC3339Nano),
		Status:        status,
		Steps:         []ObservationStep{},
		FinalStateID:  nil,
		ErrorCode:     nil,
	})
}

func stringPointer(value string) *string {
	return &value
}
