package reader

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Bound separately from the caller's excerpt. Never silently truncate a source
// advertised as the full document, including its page/chapter labels.
const fullDocumentChatBytes = 256 << 10

var errFullDocumentTooLarge = errors.New("全文正文过长，暂不支持整篇发送。请关闭“全文上下文”后选取相关段落提问")

func (s *Server) fullDocumentChatText(d Document) (string, error) {
	var text strings.Builder
	appendText := func(value string) error {
		if len(value) > fullDocumentChatBytes-text.Len() {
			return errFullDocumentTooLarge
		}
		text.WriteString(value)
		return nil
	}
	switch d.Type {
	case "pdf":
		m, err := s.readLayout(d.ID)
		if err != nil {
			return "", errors.New("全文正文尚不可用，请先完成 PDF 解析，或关闭“全文上下文”后提问")
		}
		value, err := s.fullPDFChatText(d.ID, m)
		if err != nil {
			return "", err
		}
		if err = appendText(value); err != nil {
			return "", err
		}
	case "epub":
		blocks, err := s.fullEPUBChatBlocks(d.ID)
		if err != nil {
			return "", errors.New("无法读取完整 EPUB 正文，请检查文档，或关闭“全文上下文”后提问")
		}
		href := ""
		for _, block := range blocks {
			value := strings.TrimSpace(block.Text)
			if value == "" {
				continue
			}
			if block.Location.Href != href {
				if err = appendText("\n[章节 " + block.Location.Href + "]\n"); err != nil {
					return "", err
				}
				href = block.Location.Href
			}
			if block.Image != "" {
				value = "[图片替代文字] " + value
			}
			if err = appendText(value + "\n\n"); err != nil {
				return "", err
			}
		}
	default:
		return "", errors.New("此文档类型暂不支持全文上下文")
	}
	if text.Len() == 0 {
		return "", errors.New("未能提取完整正文，无法启用全文上下文。扫描文档需先完成文字识别，或关闭“全文上下文”后提问")
	}
	return text.String(), nil
}

var chatMarkdownPages = regexp.MustCompile(`(?m)^<!-- page:([1-9][0-9]*) -->\r?$`)
var chatMarkdownComments = regexp.MustCompile(`(?s)<!--.*?-->`)
var chatMarkdownAssets = regexp.MustCompile(`(?m)^\[[^\]\r\n]*\]\(assets/p[1-9][0-9]*-b[1-9][0-9]*\.png\)\s*$`)

// paper.md retains text that could not be assigned to a layout block. The
// manifest retains extracted table/image text that paper.md represents only as
// image links. A full parse needs both, with verified page coverage.
func (s *Server) fullPDFChatText(documentID string, m layoutManifest) (string, error) {
	return fullPDFChatTextAt(s.analysisDir(documentID), m)
}

func fullPDFChatTextAt(directory string, m layoutManifest) (string, error) {
	parsed := map[int]bool{}
	for _, page := range m.ParsedPages {
		if page > 0 && page <= m.Pages {
			parsed[page] = true
		}
	}
	if len(m.IncompletePages) > 0 || (len(m.ParsedPages) > 0 && len(parsed) != m.Pages) {
		return "", errors.New("PDF 仍有页面未完成解析，暂时无法读取全文。请完成解析，或关闭“全文上下文”后提问")
	}
	missing := errors.New("未能验证 PDF 全部页面的正文已解析，请重新解析，或关闭“全文上下文”后提问")
	pages := map[int]string{}
	// Chapter merges update only the manifest, so their paper.md may be stale.
	if len(m.ParsedPages) == 0 {
		file, err := os.Open(filepath.Join(directory, "paper.md"))
		if err == nil {
			defer file.Close()
			data, readErr := io.ReadAll(io.LimitReader(file, fullDocumentChatBytes+1))
			if readErr != nil {
				return "", missing
			}
			if len(data) > fullDocumentChatBytes {
				return "", errFullDocumentTooLarge
			}
			body := string(data)
			markers := chatMarkdownPages.FindAllStringSubmatchIndex(body, -1)
			valid := len(markers) == m.Pages
			if valid {
				valid = strings.TrimSpace(body[:markers[0][0]]) == ""
			}
			for i, marker := range markers {
				number, _ := strconv.Atoi(body[marker[2]:marker[3]])
				if number != i+1 {
					valid = false
					break
				}
				end := len(body)
				if i+1 < len(markers) {
					end = markers[i+1][0]
				}
				pages[number] = strings.TrimSpace(body[marker[1]:end])
			}
			if !valid {
				return "", missing
			}
		} else if !os.IsNotExist(err) {
			return "", missing
		}
	}
	if len(pages) == 0 {
		for _, warning := range m.Warnings {
			if strings.Contains(warning, "未归入版面块") {
				return "", missing
			}
		}
	}
	// Preserve the parser's reading order within each page.
	sort.SliceStable(m.Blocks, func(i, j int) bool { return m.Blocks[i].Page < m.Blocks[j].Page })
	blockText := map[int][]string{}
	for _, block := range m.Blocks {
		if len(pages) > 0 && block.Image == "" {
			if value := strings.TrimSpace(block.Text); value != "" && !strings.Contains(pages[block.Page], value) {
				return "", missing // The Markdown and manifest disagree; do not use stale text.
			}
			continue // Already present in the complete Markdown body.
		}
		value := strings.TrimSpace(block.Text)
		caption := strings.TrimSpace(block.Caption)
		if caption != "" && caption != value {
			value += "\n" + caption
		}
		if strings.TrimSpace(value) != "" {
			blockText[block.Page] = append(blockText[block.Page], value)
		}
	}
	// Iterating only populated pages also rejects implausibly large or sparse
	// legacy manifests without looping over an untrusted page count.
	covered := map[int]bool{}
	for page, value := range pages {
		visible := chatMarkdownAssets.ReplaceAllString(chatMarkdownComments.ReplaceAllString(value, ""), "")
		if strings.TrimSpace(visible) != "" {
			covered[page] = true
		}
	}
	for page := range blockText {
		covered[page] = true
	}
	if len(covered) != m.Pages {
		return "", missing
	}
	var text strings.Builder
	for page := 1; page <= m.Pages; page++ {
		value := fmt.Sprintf("\n[第 %d 页]\n", page)
		if pages[page] != "" {
			value += pages[page] + "\n\n"
		}
		if len(blockText[page]) > 0 {
			if len(pages) > 0 {
				value += "[本页图表的已提取文字，未附加原图]\n"
			}
			value += strings.Join(blockText[page], "\n\n") + "\n\n"
		}
		if len(value) > fullDocumentChatBytes-text.Len() {
			return "", errFullDocumentTooLarge
		}
		text.WriteString(value)
	}
	return text.String(), nil
}

func (s *Server) fullEPUBChatBlocks(documentID string) (epubTranslationDocument, error) {
	// The shared EPUB text reader intentionally skips non-HTML resources. For a
	// full-context request that would silently omit an unsupported spine chapter.
	data, err := os.ReadFile(filepath.Join(s.Store.Root, "cache", documentID, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var manifest struct {
		ReadingOrder []struct {
			Type string `json:"type"`
		} `json:"readingOrder"`
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}
	if len(manifest.ReadingOrder) == 0 {
		return nil, errors.New("EPUB 没有正文目录")
	}
	for _, link := range manifest.ReadingOrder {
		if link.Type != "application/xhtml+xml" && link.Type != "text/html" {
			return nil, errors.New("EPUB 含不支持的正文章节格式")
		}
	}
	return s.readEPUBBlocks(documentID)
}
