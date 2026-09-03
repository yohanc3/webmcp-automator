package actionmap

import (
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const SchemaVersion = "action-map/1"

//go:embed action-map.schema.json
var SchemaJSON []byte

var identifierPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

type Locator struct {
	CSS          *string `json:"css"`
	Role         *string `json:"role"`
	Name         *string `json:"name"`
	Placeholder  *string `json:"placeholder"`
	Text         *string `json:"text"`
	HrefContains *string `json:"hrefContains"`
}

func (locator Locator) HasEvidence() bool {
	return nonBlank(locator.CSS) || nonBlank(locator.Role) || nonBlank(locator.Name) ||
		nonBlank(locator.Placeholder) || nonBlank(locator.Text) || nonBlank(locator.HrefContains)
}

type Site struct {
	Origin       string   `json:"origin"`
	ObservedURLs []string `json:"observedUrls"`
}

type State struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	URLPattern  string   `json:"urlPattern"`
	Fingerprint *string  `json:"fingerprint"`
	Evidence    []string `json:"evidence"`
}

type Parameter struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Type        string `json:"type"`
	Required    bool   `json:"required"`
}

type Expectation struct {
	Kind       string  `json:"kind"`
	State      *string `json:"state"`
	URLPattern *string `json:"urlPattern"`
	Target     Locator `json:"target"`
}

type Step struct {
	Operation    string      `json:"op"`
	Target       Locator     `json:"target"`
	ValueFrom    *string     `json:"valueFrom"`
	LiteralValue *string     `json:"literalValue"`
	Key          *string     `json:"key"`
	Expect       Expectation `json:"expect"`
	TimeoutMS    int         `json:"timeoutMs"`
}

type OutputField struct {
	Name      string  `json:"name"`
	Locator   Locator `json:"locator"`
	Attribute *string `json:"attribute"`
	Required  bool    `json:"required"`
}

type Output struct {
	Mode           string        `json:"mode"`
	CollectionRoot Locator       `json:"collectionRoot"`
	Item           Locator       `json:"item"`
	Limit          int           `json:"limit"`
	Fields         []OutputField `json:"fields"`
}

type Action struct {
	ID              string      `json:"id"`
	Name            string      `json:"name"`
	Description     string      `json:"description"`
	Category        string      `json:"category"`
	Status          string      `json:"status"`
	Safety          string      `json:"safety"`
	Confidence      float64     `json:"confidence"`
	FromState       string      `json:"fromState"`
	ToState         *string     `json:"toState"`
	Parameters      []Parameter `json:"parameters"`
	Steps           []Step      `json:"steps"`
	Output          Output      `json:"output"`
	Evidence        []string    `json:"evidence"`
	MissingEvidence []string    `json:"missingEvidence"`
}

type Privacy struct {
	RedactionsApplied int      `json:"redactionsApplied"`
	Categories        []string `json:"categories"`
	Policy            string   `json:"policy"`
}

type Map struct {
	SchemaVersion string   `json:"schemaVersion"`
	Site          Site     `json:"site"`
	Summary       string   `json:"summary"`
	States        []State  `json:"states"`
	Actions       []Action `json:"actions"`
	Warnings      []string `json:"warnings"`
	Privacy       Privacy  `json:"privacy"`
}

func (actionMap Map) Validate() error {
	var problems []string
	if actionMap.SchemaVersion != SchemaVersion {
		problems = append(problems, "schemaVersion must be "+SchemaVersion)
	}
	parsedOrigin, err := url.Parse(actionMap.Site.Origin)
	if err != nil || parsedOrigin.Host == "" ||
		(parsedOrigin.Scheme != "http" && parsedOrigin.Scheme != "https") {
		problems = append(problems, "site.origin must be an HTTP or HTTPS origin")
	}
	if strings.TrimSpace(actionMap.Summary) == "" {
		problems = append(problems, "summary is required")
	}
	if len(actionMap.States) == 0 || len(actionMap.States) > 16 {
		problems = append(problems, "states must contain between 1 and 16 entries")
	}
	if len(actionMap.Actions) == 0 || len(actionMap.Actions) > 40 {
		problems = append(problems, "actions must contain between 1 and 40 entries")
	}

	states := make(map[string]struct{}, len(actionMap.States))
	for _, state := range actionMap.States {
		if !identifierPattern.MatchString(state.ID) {
			problems = append(problems, "invalid state id: "+state.ID)
		}
		if _, exists := states[state.ID]; exists {
			problems = append(problems, "duplicate state id: "+state.ID)
		}
		states[state.ID] = struct{}{}
		if strings.TrimSpace(state.Label) == "" || strings.TrimSpace(state.URLPattern) == "" {
			problems = append(problems, "state label and urlPattern are required")
		}
	}

	actions := make(map[string]struct{}, len(actionMap.Actions))
	for index, action := range actionMap.Actions {
		prefix := fmt.Sprintf("action %d", index+1)
		if !identifierPattern.MatchString(action.ID) {
			problems = append(problems, prefix+" has an invalid id")
		}
		if _, exists := actions[action.ID]; exists {
			problems = append(problems, "duplicate action id: "+action.ID)
		}
		actions[action.ID] = struct{}{}
		if strings.TrimSpace(action.Name) == "" || strings.TrimSpace(action.Description) == "" {
			problems = append(problems, prefix+" requires a name and description")
		}
		if !oneOf(action.Category, "read", "navigate", "input", "submit", "change") {
			problems = append(problems, prefix+" has an invalid category")
		}
		if !oneOf(action.Status, "observed", "resolvable", "unresolved") {
			problems = append(problems, prefix+" has an invalid status")
		}
		if !oneOf(action.Safety, "read", "write", "danger") {
			problems = append(problems, prefix+" has an invalid safety level")
		}
		if action.Confidence < 0 || action.Confidence > 1 {
			problems = append(problems, prefix+" confidence must be between 0 and 1")
		}
		if _, exists := states[action.FromState]; !exists {
			problems = append(problems, prefix+" references an unknown fromState")
		}
		if nonBlank(action.ToState) {
			if _, exists := states[strings.TrimSpace(*action.ToState)]; !exists {
				problems = append(problems, prefix+" references an unknown toState")
			}
		}
		if action.Status != "unresolved" && len(action.Steps) == 0 {
			problems = append(problems, prefix+" must include executable steps")
		}
		problems = append(problems, validateAction(action, prefix, states)...)
	}

	if actionMap.Privacy.RedactionsApplied < 0 || strings.TrimSpace(actionMap.Privacy.Policy) == "" {
		problems = append(problems, "privacy summary is invalid")
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func validateAction(action Action, prefix string, states map[string]struct{}) []string {
	var problems []string
	parameters := make(map[string]struct{}, len(action.Parameters))
	for _, parameter := range action.Parameters {
		if !identifierPattern.MatchString(parameter.Name) {
			problems = append(problems, prefix+" has an invalid parameter name")
		}
		if _, exists := parameters[parameter.Name]; exists {
			problems = append(problems, prefix+" has a duplicate parameter: "+parameter.Name)
		}
		parameters[parameter.Name] = struct{}{}
		if !oneOf(parameter.Type, "string", "number", "boolean") {
			problems = append(problems, prefix+" has an invalid parameter type")
		}
	}

	for index, step := range action.Steps {
		stepPrefix := fmt.Sprintf("%s step %d", prefix, index+1)
		if !oneOf(step.Operation, "fill", "click", "press", "wait", "extract") {
			problems = append(problems, stepPrefix+" has an unsupported operation")
		}
		if oneOf(step.Operation, "fill", "click") && !step.Target.HasEvidence() {
			problems = append(problems, stepPrefix+" requires a target")
		}
		if step.Operation == "fill" {
			if !nonBlank(step.ValueFrom) && step.LiteralValue == nil {
				problems = append(problems, stepPrefix+" requires valueFrom or literalValue")
			}
			if nonBlank(step.ValueFrom) {
				if _, exists := parameters[strings.TrimSpace(*step.ValueFrom)]; !exists {
					problems = append(problems, stepPrefix+" references an unknown parameter")
				}
			}
		}
		if step.Operation == "press" && !nonBlank(step.Key) {
			problems = append(problems, stepPrefix+" requires a key")
		}
		if step.TimeoutMS < 100 || step.TimeoutMS > 30000 {
			problems = append(problems, stepPrefix+" timeoutMs must be between 100 and 30000")
		}
		if !oneOf(step.Expect.Kind, "none", "dom_change", "navigation", "collection", "element") {
			problems = append(problems, stepPrefix+" has an invalid expectation")
		}
		if nonBlank(step.Expect.State) {
			if _, exists := states[strings.TrimSpace(*step.Expect.State)]; !exists {
				problems = append(problems, stepPrefix+" expects an unknown state")
			}
		}
	}

	if !oneOf(action.Output.Mode, "none", "page", "collection") {
		problems = append(problems, prefix+" has an invalid output mode")
	}
	if action.Output.Limit < 1 || action.Output.Limit > 25 {
		problems = append(problems, prefix+" output limit must be between 1 and 25")
	}
	if action.Output.Mode == "collection" &&
		(!action.Output.Item.HasEvidence() || len(action.Output.Fields) == 0) {
		problems = append(problems, prefix+" collection output requires an item and fields")
	}
	return problems
}

func nonBlank(value *string) bool {
	return value != nil && strings.TrimSpace(*value) != ""
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
