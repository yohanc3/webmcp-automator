package manifest

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const SchemaVersion = "learned-adapter/1"

var identifierPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,29}$`)

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
	Origin        string   `json:"origin"`
	RoutePatterns []string `json:"routePatterns"`
}

type Parameter struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Type        string `json:"type"`
	Required    bool   `json:"required"`
}

type Step struct {
	Operation        string  `json:"op"`
	Target           Locator `json:"target"`
	ValueFrom        *string `json:"valueFrom"`
	LiteralValue     *string `json:"literalValue"`
	Key              *string `json:"key"`
	ExpectNavigation bool    `json:"expectNavigation"`
	TimeoutMS        int     `json:"timeoutMs"`
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

type Annotations struct {
	ReadOnlyHint         bool `json:"readOnlyHint"`
	UntrustedContentHint bool `json:"untrustedContentHint"`
}

type Tool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Safety      string      `json:"safety"`
	Parameters  []Parameter `json:"parameters"`
	Steps       []Step      `json:"steps"`
	Output      Output      `json:"output"`
	Annotations Annotations `json:"annotations"`
}

type Adapter struct {
	SchemaVersion string   `json:"schemaVersion"`
	Usable        bool     `json:"usable"`
	Site          Site     `json:"site"`
	Tool          Tool     `json:"tool"`
	Confidence    float64  `json:"confidence"`
	Evidence      string   `json:"evidence"`
	Issues        []string `json:"issues"`
}

func (adapter Adapter) Validate() error {
	var problems []string
	if adapter.SchemaVersion != SchemaVersion {
		problems = append(problems, "schemaVersion must be "+SchemaVersion)
	}
	if !adapter.Usable {
		problems = append(problems, append([]string{"adapter is not usable"}, adapter.Issues...)...)
	}
	parsedOrigin, err := url.Parse(adapter.Site.Origin)
	if err != nil || parsedOrigin.Host == "" || (parsedOrigin.Scheme != "http" && parsedOrigin.Scheme != "https") {
		problems = append(problems, "site.origin must be an HTTP or HTTPS origin")
	}
	if !identifierPattern.MatchString(adapter.Tool.Name) {
		problems = append(problems, "tool.name must be lowercase snake_case and at most 30 characters")
	}
	if strings.TrimSpace(adapter.Tool.Description) == "" {
		problems = append(problems, "tool.description is required")
	}
	if adapter.Tool.Safety != "read" && adapter.Tool.Safety != "write" && adapter.Tool.Safety != "danger" {
		problems = append(problems, "tool.safety is invalid")
	}
	if adapter.Confidence < 0 || adapter.Confidence > 1 {
		problems = append(problems, "confidence must be between 0 and 1")
	}

	parameters := make(map[string]struct{}, len(adapter.Tool.Parameters))
	for _, parameter := range adapter.Tool.Parameters {
		if !identifierPattern.MatchString(parameter.Name) {
			problems = append(problems, "invalid parameter name: "+parameter.Name)
		}
		if _, exists := parameters[parameter.Name]; exists {
			problems = append(problems, "duplicate parameter name: "+parameter.Name)
		}
		parameters[parameter.Name] = struct{}{}
		if parameter.Type != "string" && parameter.Type != "number" && parameter.Type != "boolean" {
			problems = append(problems, "invalid parameter type for "+parameter.Name)
		}
	}

	if len(adapter.Tool.Steps) == 0 || len(adapter.Tool.Steps) > 20 {
		problems = append(problems, "tool.steps must contain between 1 and 20 operations")
	}
	for index, step := range adapter.Tool.Steps {
		stepNumber := index + 1
		switch step.Operation {
		case "fill", "click", "press", "wait", "extract":
		default:
			problems = append(problems, fmt.Sprintf("step %d uses unsupported operation %s", stepNumber, step.Operation))
		}
		if (step.Operation == "fill" || step.Operation == "click") && !step.Target.HasEvidence() {
			problems = append(problems, fmt.Sprintf("step %d requires a target locator", stepNumber))
		}
		if step.Operation == "fill" {
			if !nonBlank(step.ValueFrom) && step.LiteralValue == nil {
				problems = append(problems, fmt.Sprintf("step %d must declare valueFrom or literalValue", stepNumber))
			}
			if nonBlank(step.ValueFrom) {
				if _, exists := parameters[strings.TrimSpace(*step.ValueFrom)]; !exists {
					problems = append(problems, fmt.Sprintf("step %d references an unknown parameter", stepNumber))
				}
			}
		}
		if step.Operation == "press" && !nonBlank(step.Key) {
			problems = append(problems, fmt.Sprintf("step %d requires a key", stepNumber))
		}
		if step.TimeoutMS < 100 || step.TimeoutMS > 30000 {
			problems = append(problems, fmt.Sprintf("step %d timeoutMs must be between 100 and 30000", stepNumber))
		}
	}

	if adapter.Tool.Output.Mode != "page" && adapter.Tool.Output.Mode != "collection" {
		problems = append(problems, "tool.output.mode is invalid")
	}
	if adapter.Tool.Output.Limit < 1 || adapter.Tool.Output.Limit > 25 {
		problems = append(problems, "tool.output.limit must be between 1 and 25")
	}
	if adapter.Tool.Output.Mode == "collection" {
		if !adapter.Tool.Output.Item.HasEvidence() {
			problems = append(problems, "collection output requires an item locator")
		}
		if len(adapter.Tool.Output.Fields) == 0 {
			problems = append(problems, "collection output requires at least one field")
		}
	}

	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func nonBlank(value *string) bool {
	return value != nil && strings.TrimSpace(*value) != ""
}
