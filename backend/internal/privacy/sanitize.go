package privacy

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

const redactionMarker = "[redacted]"

var (
	emailPattern   = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	phonePattern   = regexp.MustCompile(`(?:\+?\d[\d\s().-]{7,}\d)`)
	cardPattern    = regexp.MustCompile(`\b(?:\d[ -]*?){13,19}\b`)
	secretPattern  = regexp.MustCompile(`(?i)\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?\b`)
	addressPattern = regexp.MustCompile(`(?i)\b\d{1,6}\s+[A-Za-z0-9 .'-]{2,50}\s(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct)\b`)
	accountPattern = regexp.MustCompile(`(?i)\b(?:hello|hi|deliver to|ship to|account for)\s*,?\s+[A-Z][A-Za-z'-]{1,30}\b`)
	longIDPattern  = regexp.MustCompile(`\b(?:\d[ -]?){8,}\b`)
	pathIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{16,}$`)
)

type Summary struct {
	RedactionsApplied int      `json:"redactionsApplied"`
	Categories        []string `json:"categories"`
}

type sanitizer struct {
	redactions int
	categories map[string]struct{}
}

func SanitizeTrace(trace json.RawMessage) (json.RawMessage, Summary, error) {
	if !json.Valid(trace) {
		return nil, Summary{}, errors.New("trace must be valid JSON")
	}
	var document any
	if err := json.Unmarshal(trace, &document); err != nil {
		return nil, Summary{}, err
	}
	processor := sanitizer{categories: map[string]struct{}{}}
	document = processor.value(document, "")
	output, err := json.Marshal(document)
	if err != nil {
		return nil, Summary{}, err
	}
	categories := make([]string, 0, len(processor.categories))
	for category := range processor.categories {
		categories = append(categories, category)
	}
	sort.Strings(categories)
	return output, Summary{
		RedactionsApplied: processor.redactions,
		Categories:        categories,
	}, nil
}

func (processor *sanitizer) value(value any, key string) any {
	switch typed := value.(type) {
	case map[string]any:
		if _, hasRedactionFlag := typed["redacted"]; hasRedactionFlag {
			if rawValue, exists := typed["value"]; exists && rawValue != nil {
				switch rawValue.(type) {
				case string, float64:
					typed["value"] = redactionMarker + " user input"
					typed["redacted"] = true
					processor.record("user_input")
				}
			}
		}
		for childKey, childValue := range typed {
			if childKey == "semanticXml" {
				delete(typed, childKey)
				processor.record("duplicate_markup")
				continue
			}
			typed[childKey] = processor.value(childValue, childKey)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = processor.value(item, key)
		}
		return typed
	case string:
		if strings.Contains(strings.ToLower(key), "url") || strings.EqualFold(key, "href") {
			return processor.cleanURL(typed)
		}
		return processor.cleanString(typed)
	default:
		return value
	}
}

func (processor *sanitizer) cleanURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return processor.cleanString(value)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		parsed.RawQuery = ""
		parsed.Fragment = ""
		processor.record("url_parameters")
	}
	segments := strings.Split(parsed.Path, "/")
	for index, segment := range segments {
		if pathIDPattern.MatchString(segment) {
			segments[index] = redactionMarker
			processor.record("url_identifier")
		}
	}
	parsed.Path = strings.Join(segments, "/")
	return parsed.String()
}

func (processor *sanitizer) cleanString(value string) string {
	cleaned := value
	cleaned = processor.replace(cleaned, emailPattern, "email")
	cleaned = processor.replace(cleaned, cardPattern, "payment_number")
	cleaned = processor.replace(cleaned, phonePattern, "phone")
	cleaned = processor.replace(cleaned, secretPattern, "credential")
	cleaned = processor.replace(cleaned, addressPattern, "street_address")
	cleaned = processor.replace(cleaned, accountPattern, "account_name")
	cleaned = processor.replace(cleaned, longIDPattern, "long_identifier")
	return cleaned
}

func (processor *sanitizer) replace(value string, pattern *regexp.Regexp, category string) string {
	matches := pattern.FindAllStringIndex(value, -1)
	if len(matches) == 0 {
		return value
	}
	for range matches {
		processor.record(category)
	}
	return pattern.ReplaceAllString(value, redactionMarker)
}

func (processor *sanitizer) record(category string) {
	processor.redactions += 1
	processor.categories[category] = struct{}{}
}
