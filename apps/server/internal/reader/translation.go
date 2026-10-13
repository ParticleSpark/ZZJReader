package reader

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"
)

type TranslationSentence struct {
	// Source is the model's sentence, which may repair extraction errors.
	Source string `json:"source"`
	Target string `json:"target"`
	// Anchor is the extracted text the sentence covers, set when it differs
	// from Source. Readers locate sentences in the PDF text layer by it.
	Anchor string `json:"anchor,omitempty"`
}
type TranslationBlock struct {
	BlockID         string                `json:"blockId"`
	SourceHash      string                `json:"sourceHash"`
	Status          string                `json:"status"`
	Sentences       []TranslationSentence `json:"sentences"`
	FormulaMarkdown string                `json:"formulaMarkdown,omitempty"`
	Error           string                `json:"error,omitempty"`
}

func translationSource(b PDFBlock) string {
	if isPDFPageDecoration(b) {
		return ""
	}
	switch b.Label {
	case "reference", "reference_content", "algorithm", "display_formula", "inline_formula", "formula_number", "header", "footer", "number":
		return ""
	}
	if isImageAsset(b) {
		return strings.TrimSpace(b.Caption)
	}
	return strings.TrimSpace(b.Text)
}
func translationHash(source string) string {
	sum := sha256.Sum256([]byte("zh-CN:v1:" + source))
	return hex.EncodeToString(sum[:])
}
func needsTranslation(b PDFBlock) bool {
	return translationSource(b) != "" || (isFormula(b) && b.Image != "")
}
func newTranslation(b PDFBlock) TranslationBlock {
	source := translationSource(b)
	if isFormula(b) {
		source = "formula-image:v1:" + b.Image + ":" + b.Text
	}
	return TranslationBlock{BlockID: b.ID, SourceHash: translationHash(source), Status: "pending", Sentences: []TranslationSentence{}}
}

// Book paragraphs stay idle until requested; PDF papers translate in full.
func (s *Server) translations(documentID string, m translationInput) ([]TranslationBlock, error) {
	d, err := s.Store.Document(documentID)
	if err != nil {
		return nil, err
	}
	rows, err := s.Store.DB.Query("SELECT body FROM translations WHERE document_id=?", documentID)
	if err != nil {
		return nil, err
	}
	saved := map[string]TranslationBlock{}
	for rows.Next() {
		var body string
		var t TranslationBlock
		if err = rows.Scan(&body); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(body), &t); err != nil {
			rows.Close()
			return nil, errors.New("译文记录损坏")
		}
		saved[t.BlockID+":"+t.SourceHash] = t
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	result := []TranslationBlock{}
	for _, t := range m.translationItems() {
		if value, ok := saved[t.BlockID+":"+t.SourceHash]; ok {
			t = value
		} else if d.Library == "books" || d.Type == "epub" {
			t.Status = "idle"
		}
		result = append(result, t)
	}
	return result, nil
}

func (s *Server) retryFailedTranslations(documentID string) error {
	m, err := s.readTranslationSource(documentID)
	if err != nil {
		return nil
	}
	items, err := s.translations(documentID, m)
	if err != nil {
		return err
	}
	for _, t := range items {
		if t.Status == "failed" {
			t.Status = "pending"
			t.Error = ""
			if err = s.saveTranslation(documentID, t); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) saveTranslation(documentID string, t TranslationBlock) error {
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	return s.saveTranslationLocked(documentID, t)
}

type translationWriter interface {
	Exec(string, ...any) (sql.Result, error)
}

func writeTranslation(writer translationWriter, documentID string, t TranslationBlock) error {
	body, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = writer.Exec(`INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?) ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET status=excluded.status,body=excluded.body`, documentID, t.BlockID, t.SourceHash, t.Status, string(body))
	return err
}

// The caller holds translationMu across the read, validation and write.
func (s *Server) saveTranslationLocked(documentID string, t TranslationBlock) error {
	err := writeTranslation(s.Store.DB, documentID, t)
	if err == nil {
		s.publishTranslation(documentID, t)
	}
	return err
}
func (s *Server) documentTranslations(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		respond(w, 200, []TranslationBlock{})
		return
	}
	items, err := s.translations(d.ID, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	respond(w, 200, items)
}

// Requests only enqueue work. The translation lane owns provider calls and persists
// completed responses independently, so closing a reader never loses progress.
func (s *Server) requestTranslation(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	var req struct {
		BlockID string `json:"blockId"`
		Force   bool   `json:"force"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Force {
		s.forceTranslation(w, r, d, req.BlockID)
		return
	}
	if req.BlockID == "" && (d.Library == "books" || d.Type == "epub") {
		fail(w, 400, "图书请按章节翻译")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文仍在解析中")
		return
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	p, err := s.Store.processing(d.ID)
	if err != nil || !p.Enabled {
		fail(w, 409, "请先开始翻译")
		return
	}
	items, err := s.translations(d.ID, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	found := req.BlockID == ""
	for _, t := range items {
		if req.BlockID != "" && t.BlockID != req.BlockID {
			continue
		}
		found = true
		if t.Status == "complete" || t.Status == "running" {
			continue
		}
		t.Status = "pending"
		t.Error = ""
		if err = s.saveTranslation(d.ID, t); err != nil {
			fail(w, 500, "无法保存翻译任务")
			return
		}
	}
	if !found {
		fail(w, 404, "没有可翻译的段落")
		return
	}
	if p.Status != "running" || (p.Translating != nil && p.Translating.Status != "running") {
		if p.Phase == "ready" {
			p.Phase = "translating"
		}
		p.Status = "queued"
		p.Detail = "等待继续处理"
		p.queueTranslation = true
		if err = s.Store.saveProcessing(p); err != nil {
			fail(w, 500, "无法安排翻译任务")
			return
		}
	}
	respond(w, 202, map[string]bool{"queued": true})
}

// Join the old worker before clearing its output. Queueing alone cannot prevent
// an in-flight response from overwriting the replacement request.
func (s *Server) forceTranslation(w http.ResponseWriter, r *http.Request, d Document, blockID string) {
	s.processingControlMu.Lock()
	defer s.processingControlMu.Unlock()
	ctx, finish, err := s.beginDocumentTask(r.Context(), d.ID)
	if err != nil {
		fail(w, 409, "文档当前不可修改")
		return
	}
	defer finish()
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文仍在解析中")
		return
	}
	s.processingMu.Lock()
	p, err := s.Store.processing(d.ID)
	if err != nil || (!p.Enabled && p.Translating == nil) {
		s.processingMu.Unlock()
		fail(w, 409, "请先开始翻译")
		return
	}
	if p.Phase == "learning" && p.Status != "complete" {
		s.processingMu.Unlock()
		fail(w, 409, "请先完成正文解析，再重新翻译")
		return
	}
	items, err := s.translations(d.ID, m)
	if err != nil || len(retranslationItems(d, items, blockID)) == 0 {
		s.processingMu.Unlock()
		if err != nil {
			fail(w, 500, "无法读取译文")
		} else {
			fail(w, 404, "没有可重新翻译的段落")
		}
		return
	}
	if s.blockedProcessing == nil {
		s.blockedProcessing = map[string]bool{}
	}
	s.blockedProcessing[d.ID] = true
	task := s.activeProcessing[d.ID]
	if task != nil {
		task.cancel()
	}
	s.processingMu.Unlock()
	defer func() {
		s.processingMu.Lock()
		delete(s.blockedProcessing, d.ID)
		s.processingMu.Unlock()
	}()
	if task != nil {
		select {
		case <-task.done:
		case <-ctx.Done():
			fail(w, 408, "重新翻译已取消")
			return
		}
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	s.Store.processingWriteMu.Lock()
	defer s.Store.processingWriteMu.Unlock()
	if ctx.Err() != nil {
		fail(w, 408, "重新翻译已取消")
		return
	}
	// The finishing worker may have published a chapter or its last sentences.
	m, err = s.readTranslationSource(d.ID)
	if err == nil {
		items, err = s.translations(d.ID, m)
	}
	if err == nil {
		p, err = s.Store.processing(d.ID)
	}
	if err != nil {
		fail(w, 500, "无法读取最新翻译状态")
		return
	}
	replacements := retranslationItems(d, items, blockID)
	if len(replacements) == 0 {
		fail(w, 404, "没有可重新翻译的段落")
		return
	}
	p.Enabled, p.Phase, p.Status = true, "translating", "queued"
	p.Detail, p.CompletedAt = "等待重新翻译", ""
	p.Translating = &ProcessingStage{Status: "queued", Detail: p.Detail}
	p.UpdatedAt = now()
	replaced := map[string]bool{}
	for _, item := range replacements {
		replaced[item.BlockID] = true
	}
	for i := range items {
		if replaced[items[i].BlockID] {
			items[i].Status = "pending"
		}
	}
	p.TranslationsDone, p.TranslationsTotal = translationCounts(items)
	processingBody, err := json.Marshal(p)
	if err != nil {
		fail(w, 500, "无法安排翻译任务")
		return
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err == nil {
		defer tx.Rollback()
		for _, item := range replacements {
			if err = writeTranslation(tx, d.ID, item); err != nil {
				break
			}
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, "UPDATE document_processing SET phase=?,status=?,body=? WHERE document_id=?", p.Phase, p.Status, processingBody, d.ID)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		fail(w, 500, "无法安排重新翻译，已保留现有译文")
		return
	}
	for _, item := range replacements {
		s.publishTranslation(d.ID, item)
	}
	respond(w, 202, map[string]bool{"queued": true})
}

func retranslationItems(d Document, items []TranslationBlock, blockID string) []TranslationBlock {
	selected := []TranslationBlock{}
	for _, item := range items {
		if blockID != "" && item.BlockID != blockID {
			continue
		}
		// Full-book replacement never authorizes chapters the reader did not ask
		// to translate. An explicit block request remains limited to that block.
		if blockID == "" && (d.Library == "books" || d.Type == "epub") && item.Status == "idle" {
			continue
		}
		item.Status, item.Error, item.FormulaMarkdown = "pending", "", ""
		item.Sentences = []TranslationSentence{}
		selected = append(selected, item)
	}
	return selected
}

func (s *Server) updateTranslation(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	var req struct {
		Index          *int   `json:"index"`
		Target         string `json:"target"`
		SourceHash     string `json:"sourceHash"`
		Source         string `json:"source"`
		ExpectedTarget string `json:"expectedTarget"`
	}
	if !decode(w, r, &req) {
		return
	}
	target := strings.TrimSpace(req.Target)
	if target == "" {
		fail(w, 400, "译文不能为空")
		return
	}
	if utf8.RuneCountInString(target) > 20000 {
		fail(w, 400, "译文过长")
		return
	}
	if req.Index == nil || req.SourceHash == "" || req.Source == "" || req.ExpectedTarget == "" {
		fail(w, 400, "缺少要修改的原句和译文版本")
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), d.ID)
	if err != nil {
		fail(w, 409, "文档当前不可修改")
		return
	}
	defer finish()
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文仍在解析中")
		return
	}
	items, err := s.translations(d.ID, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	blockID := r.PathValue("blockId")
	for _, t := range items {
		if t.BlockID != blockID {
			continue
		}
		index := *req.Index
		if index < 0 || index >= len(t.Sentences) || t.Status != "complete" || t.SourceHash != req.SourceHash || t.Sentences[index].Source != req.Source || t.Sentences[index].Target != req.ExpectedTarget {
			fail(w, 409, "译文已经更新，请核对最新句子后重试")
			return
		}
		if ctx.Err() != nil {
			fail(w, 408, "译文修改已取消")
			return
		}
		t.Sentences[index].Target = target
		if err = s.saveTranslationLocked(d.ID, t); err != nil {
			fail(w, 500, "无法保存译文")
			return
		}
		respond(w, 200, t)
		return
	}
	fail(w, 404, "没有这一段译文")
}

func parseTranslation(raw, source string) ([]TranslationSentence, error) {
	return parseTranslationSource(raw, source, true)
}

func parseTranslationSource(raw, source string, repairPDF bool) ([]TranslationSentence, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```") {
		if i := strings.IndexByte(raw, '\n'); i >= 0 {
			raw = strings.TrimSpace(raw[i+1:])
			raw = strings.TrimSpace(strings.TrimSuffix(raw, "```"))
		}
	}
	var out struct {
		Sentences []TranslationSentence `json:"sentences"`
	}
	if json.Unmarshal([]byte(raw), &out) != nil || len(out.Sentences) == 0 {
		return nil, errors.New("译文格式不完整，请重试此段")
	}
	var joined strings.Builder
	for i, sentence := range out.Sentences {
		out.Sentences[i].Anchor = ""
		if strings.TrimSpace(sentence.Source) == "" || strings.TrimSpace(sentence.Target) == "" {
			return nil, errors.New("译文存在空句，请重试此段")
		}
		joined.WriteString(sentence.Source)
		joined.WriteByte(' ')
	}
	normalize := func(v string) string { return strings.Join(strings.Fields(v), "") }
	if normalize(joined.String()) == normalize(source) {
		return out.Sentences, nil
	}
	if !repairPDF || !similarText(joined.String(), source) {
		return nil, errors.New("原文句子未完整对应，请重试此段")
	}
	for i, anchor := range alignAnchors(source, out.Sentences) {
		out.Sentences[i].Anchor = anchor
	}
	return out.Sentences, nil
}
