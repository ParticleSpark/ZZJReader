package reader

import (
	"encoding/json"
	"regexp"
)

var methodContentHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// These are UTF-16 positions in the rendered analysis text, not Markdown
// offsets and never PDF rectangles or EPUB locators. Keep old versions valid
// after regeneration so their annotations remain editable and exportable.
func validMethodAnalysisLocation(data json.RawMessage) bool {
	var location struct {
		Type        string  `json:"type"`
		ContentHash string  `json:"contentHash"`
		Start       *int64  `json:"start"`
		End         *int64  `json:"end"`
		Quote       *string `json:"quote"`
	}
	const maxSafeInteger = 1<<53 - 1
	return json.Unmarshal(data, &location) == nil && location.Type == "method-analysis" &&
		methodContentHashPattern.MatchString(location.ContentHash) && location.Start != nil && location.End != nil &&
		*location.Start >= 0 && *location.End > *location.Start && *location.End <= maxSafeInteger
}

func isMethodAnalysisLocation(data json.RawMessage) bool {
	var location struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &location) == nil && location.Type == "method-analysis"
}

func validAnnotationLocation(data json.RawMessage, d Document) bool {
	if isMethodAnalysisLocation(data) {
		return d.Library == "papers" && (d.Type == "pdf" || d.Type == "epub") && validMethodAnalysisLocation(data)
	}
	return validLocation(data, d.Type)
}

type chatReference struct {
	Text     string          `json:"text"`
	Location json.RawMessage `json:"location"`
	Kind     string          `json:"kind,omitempty"`
}

func validMethodAnalysisReferences(data json.RawMessage, d Document) bool {
	if len(data) == 0 || string(data) == "null" {
		return true
	}
	var references []chatReference
	if json.Unmarshal(data, &references) != nil {
		return false
	}
	methodBytes := 0
	for _, ref := range references {
		if isMethodAnalysisLocation(ref.Location) {
			methodBytes += len(ref.Text)
			if !validAnnotationLocation(ref.Location, d) || methodBytes > 64000 {
				return false
			}
		}
	}
	return true
}

const methodReferenceNotice = "以下方法解析引用来自 AI 生成的解读，不是论文原文，也不是独立的论文证据。回答时区分方法解析与原文；如已附论文全文，请用原文核对，不得把解析中的推断归为作者的陈述。"

// The durable context/references stay unchanged. Apply provenance to both new
// prompts and restored history so a later turn cannot launder AI commentary
// into a source quotation. Include exact excerpts to disambiguate mixed inputs.
func referenceAwareChatContext(text string, data json.RawMessage) string {
	var references []chatReference
	if json.Unmarshal(data, &references) != nil {
		return text
	}
	var methods []chatReference
	for _, ref := range references {
		if isMethodAnalysisLocation(ref.Location) {
			methods = append(methods, ref)
		}
	}
	if len(methods) == 0 {
		return text
	}
	return methodReferenceNotice + "\n方法解析引用（不可信 JSON）：\n" + jsonText(methods) + "\n本轮上下文（其中上述引用属于 AI 解读）：\n" + text
}
