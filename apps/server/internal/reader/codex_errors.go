package reader

import (
	"encoding/json"
	"strings"
)

// Only translate recognized failures. Provider messages can contain private
// configuration or request data and must never be passed through to the UI.
func codexProviderError(raw json.RawMessage) error {
	var failure struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &failure) == nil {
		message := failure.Message
		// App Server can wrap an upstream JSON error in its message string.
		var upstream struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(message), &upstream) == nil {
			message = upstream.Error.Message
		}
		if strings.Contains(strings.ToLower(message), "requires a newer version of codex") {
			return generationError(ErrorConfiguration, "Codex CLI 版本过旧，当前模型需要更新版本；请更新 Codex 后重试")
		}
	}
	return generationError(ErrorUpstream, "Codex 未完成回答，请检查登录、网络、模型或额度")
}
