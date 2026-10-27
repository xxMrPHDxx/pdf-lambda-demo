package finalizer

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"os"
	"sort"
	"strings"
	"time"

	"pdfdemo/lambdas/internal/cache"
	"pdfdemo/lambdas/internal/config"
	"pdfdemo/lambdas/internal/domain"
	"pdfdemo/lambdas/internal/store"
)

// ZipWorker builds, caches and emails the final supplier-grouped archive.
type ZipWorker struct {
	cfg   config.Config
	store *store.Store
}

func NewZipWorker(cfg config.Config, st *store.Store) *ZipWorker {
	return &ZipWorker{cfg: cfg, store: st}
}

func (w *ZipWorker) HandleMessage(ctx context.Context, body []byte) error {
	var msg domain.FinalizeMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return fmt.Errorf("decode finalize message: %w", err)
	}
	if msg.JobID == "" {
		return fmt.Errorf("invalid finalize message: %s", string(body))
	}
	if err := w.process(ctx, msg); err != nil {
		slog.ErrorContext(ctx, "finalize failed", "jobId", msg.JobID, "error", err)
		job, getErr := w.store.GetJob(ctx, msg.JobID)
		if getErr == nil && job.Status == domain.JobCompleted {
			return nil
		}
		_ = w.store.MarkJobFailed(ctx, msg.JobID, err.Error())
		return err
	}
	return nil
}

func (w *ZipWorker) process(ctx context.Context, msg domain.FinalizeMessage) error {
	job, err := w.store.GetJob(ctx, msg.JobID)
	if err != nil {
		return err
	}
	switch job.Status {
	case domain.JobCompleted:
		slog.InfoContext(ctx, "job already completed, skipping finalize", "jobId", job.JobID)
		return nil
	case domain.JobFailed:
		slog.WarnContext(ctx, "job failed, skipping finalize", "jobId", job.JobID)
		return nil
	}
	if err := w.store.SetJobFinalizing(ctx, job.JobID); err != nil {
		fresh, getErr := w.store.GetJob(ctx, job.JobID)
		if getErr == nil && (fresh.Status == domain.JobCompleted || fresh.Status == domain.JobFailed) {
			return nil
		}
		return err
	}

	batches, err := w.store.ListBatches(ctx, job.JobID)
	if err != nil {
		return err
	}
	docs := make([]domain.DocRef, 0, job.PDFsTotal)
	seen := make(map[string]struct{})
	for _, batch := range batches {
		if batch.Status != domain.BatchDone {
			return fmt.Errorf("batch %d is %s, refusing to build incomplete ZIP", batch.Index, batch.Status)
		}
		for _, doc := range batch.Docs {
			if _, dup := seen[doc.Key]; dup {
				continue
			}
			seen[doc.Key] = struct{}{}
			docs = append(docs, doc)
		}
	}
	if len(docs) == 0 {
		return fmt.Errorf("job %s has no documents to zip", job.JobID)
	}
	sort.Slice(docs, func(i, j int) bool {
		if docs[i].Supplier == docs[j].Supplier {
			return docs[i].FileName < docs[j].FileName
		}
		return docs[i].Supplier < docs[j].Supplier
	})

	zipKey := cache.ZipKey(job.ClientID, job.FilterHash)
	exists, lastModified, existingSize, err := w.store.Head(ctx, zipKey)
	if err != nil {
		return err
	}
	zipCached := exists && cache.ZipIsFresh(lastModified, time.Now().UTC(), w.cfg.ZipCacheTTL)
	var zipBytes int64
	supplierCounts := countBySupplier(docs)
	if zipCached {
		zipBytes = existingSize
		slog.InfoContext(ctx, "zip cache hit", "jobId", job.JobID, "key", zipKey, "bytes", zipBytes, "age", time.Since(lastModified).Round(time.Second).String())
	} else {
		path, size, err := w.buildZip(ctx, job, docs, supplierCounts)
		if err != nil {
			return err
		}
		defer os.Remove(path)
		contentDisposition := fmt.Sprintf("attachment; filename=%q", fmt.Sprintf("%s-%s.zip", domain.Slug(job.ClientID), job.FilterHash[:8]))
		_, err = w.store.PutFile(ctx, zipKey, "application/zip", contentDisposition, path, map[string]string{
			"job-id":      job.JobID,
			"client-id":   job.ClientID,
			"filter-hash": job.FilterHash,
			"documents":   fmt.Sprint(len(docs)),
			"built-at":    time.Now().UTC().Format(time.RFC3339),
		})
		if err != nil {
			return err
		}
		zipBytes = size
		slog.InfoContext(ctx, "zip built", "jobId", job.JobID, "key", zipKey, "bytes", zipBytes, "docs", len(docs))
	}

	downloadURL, err := w.store.PresignGet(ctx, zipKey)
	if err != nil {
		return err
	}
	subject, textBody, htmlBody := renderEmail(job, docs, supplierCounts, downloadURL, zipCached, w.cfg.PresignExpires, w.cfg.PortalURL)
	emailCopy := map[string]any{
		"jobId":       job.JobID,
		"to":          job.Email,
		"from":        w.cfg.SESFrom,
		"subject":     subject,
		"html":        htmlBody,
		"text":        textBody,
		"downloadUrl": downloadURL,
		"zipCached":   zipCached,
		"documents":   len(docs),
		"sentAt":      time.Now().UTC().Format(time.RFC3339),
	}
	result, sendErr := w.store.SendEmail(ctx, job.Email, subject, textBody, htmlBody)
	emailError := ""
	if sendErr != nil {
		emailError = sendErr.Error()
		emailCopy["error"] = emailError
		slog.ErrorContext(ctx, "email send failed", "jobId", job.JobID, "error", sendErr)
	} else {
		emailCopy["messageId"] = result.MessageID
	}
	if w.cfg.SaveEmailToS3 {
		if err := w.store.PutJSON(ctx, cache.EmailKey(job.JobID), emailCopy); err != nil {
			slog.WarnContext(ctx, "could not persist email copy", "jobId", job.JobID, "error", err)
		}
	}

	err = w.store.CompleteJob(ctx, job.JobID, store.Completion{
		ZipKey:         zipKey,
		ZipBytes:       zipBytes,
		ZipCached:      zipCached,
		DownloadURL:    downloadURL,
		EmailMessageID: result.MessageID,
		EmailError:     emailError,
		SupplierCounts: supplierCounts,
		PDFsDone:       len(docs),
	})
	if err != nil && !errors.Is(err, store.ErrCondition) {
		return err
	}
	slog.InfoContext(ctx, "job completed", "jobId", job.JobID, "docs", len(docs), "zipCached", zipCached, "email", job.Email)
	return nil
}

func countBySupplier(docs []domain.DocRef) map[string]int {
	out := make(map[string]int)
	for _, d := range docs {
		out[d.Supplier]++
	}
	return out
}

func (w *ZipWorker) buildZip(ctx context.Context, job *domain.Job, docs []domain.DocRef, supplierCounts map[string]int) (string, int64, error) {
	tmp, err := os.CreateTemp("", "pdf-demo-*.zip")
	if err != nil {
		return "", 0, fmt.Errorf("create temp zip: %w", err)
	}
	path := tmp.Name()
	zw := zip.NewWriter(tmp)

	folders := map[string]string{}
	usedFolders := map[string]bool{}
	names := map[string]map[string]bool{}
	for _, doc := range docs {
		folder, ok := folders[doc.Supplier]
		if !ok {
			folder = uniqueFolder(domain.SafeFolder(doc.Supplier), usedFolders)
			folders[doc.Supplier] = folder
		}
		if names[folder] == nil {
			names[folder] = map[string]bool{}
		}
		name := uniqueName(doc.FileName, names[folder])
		data, err := w.store.GetBytes(ctx, doc.Key)
		if err != nil {
			zw.Close()
			tmp.Close()
			os.Remove(path)
			return "", 0, err
		}
		header := &zip.FileHeader{Name: folder + "/" + name, Method: zip.Deflate}
		header.SetModTime(time.Now())
		writer, err := zw.CreateHeader(header)
		if err != nil {
			zw.Close()
			tmp.Close()
			os.Remove(path)
			return "", 0, fmt.Errorf("zip entry: %w", err)
		}
		if _, err := writer.Write(data); err != nil {
			zw.Close()
			tmp.Close()
			os.Remove(path)
			return "", 0, fmt.Errorf("write zip entry: %w", err)
		}
	}

	type manifestDoc struct {
		OrderID  string `json:"orderId"`
		Supplier string `json:"supplier"`
		Path     string `json:"path"`
		CacheKey string `json:"cacheKey"`
	}
	manifest := struct {
		JobID          string         `json:"jobId"`
		ClientID       string         `json:"clientId"`
		FilterHash     string         `json:"filterHash"`
		GeneratedAt    string         `json:"generatedAt"`
		Documents      int            `json:"documents"`
		SupplierCounts map[string]int `json:"supplierCounts"`
		Files          []manifestDoc  `json:"files"`
	}{
		JobID:          job.JobID,
		ClientID:       job.ClientID,
		FilterHash:     job.FilterHash,
		GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		Documents:      len(docs),
		SupplierCounts: supplierCounts,
		Files:          make([]manifestDoc, 0, len(docs)),
	}
	for _, doc := range docs {
		folder := folders[doc.Supplier]
		manifest.Files = append(manifest.Files, manifestDoc{
			OrderID:  doc.OrderID,
			Supplier: doc.Supplier,
			Path:     folder + "/" + doc.FileName,
			CacheKey: doc.Key,
		})
	}
	manifestJSON, _ := json.MarshalIndent(manifest, "", "  ")
	if err := writeZipFile(zw, "manifest.json", manifestJSON); err != nil {
		zw.Close()
		tmp.Close()
		os.Remove(path)
		return "", 0, err
	}
	readme := `PaperTrail order pack

This archive contains one PDF per order and supplier, grouped into folders by supplier name.
manifest.json lists every file, its source order and cache key.

Generated by pdf-lambda-demo.
`
	if err := writeZipFile(zw, "README.txt", []byte(readme)); err != nil {
		zw.Close()
		tmp.Close()
		os.Remove(path)
		return "", 0, err
	}
	if err := zw.Close(); err != nil {
		tmp.Close()
		os.Remove(path)
		return "", 0, fmt.Errorf("close zip: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(path)
		return "", 0, fmt.Errorf("close temp file: %w", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		os.Remove(path)
		return "", 0, fmt.Errorf("stat zip: %w", err)
	}
	return path, st.Size(), nil
}

func writeZipFile(zw *zip.Writer, name string, data []byte) error {
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetModTime(time.Now())
	writer, err := zw.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("zip entry %s: %w", name, err)
	}
	if _, err := writer.Write(data); err != nil {
		return fmt.Errorf("write zip entry %s: %w", name, err)
	}
	return nil
}

func uniqueFolder(base string, used map[string]bool) string {
	candidate := base
	for i := 2; used[candidate]; i++ {
		candidate = fmt.Sprintf("%s (%d)", base, i)
	}
	used[candidate] = true
	return candidate
}

func uniqueName(base string, used map[string]bool) string {
	candidate := base
	stem := strings.TrimSuffix(base, ".pdf")
	for i := 2; used[candidate]; i++ {
		candidate = fmt.Sprintf("%s-%d.pdf", stem, i)
	}
	used[candidate] = true
	return candidate
}

func renderEmail(job *domain.Job, docs []domain.DocRef, counts map[string]int, downloadURL string, zipCached bool, ttl time.Duration, portalURL string) (string, string, string) {
	subject := fmt.Sprintf("Your PDF pack is ready - %d documents", len(docs))

	suppliers := make([]string, 0, len(counts))
	for s := range counts {
		suppliers = append(suppliers, s)
	}
	sort.Strings(suppliers)

	var text strings.Builder
	fmt.Fprintf(&text, "Hello,\n\nYour PDF pack for %s is ready.\n\n", job.ClientName)
	fmt.Fprintf(&text, "Job: %s\nDocuments: %d\nSuppliers: %d\n\n", job.JobID, len(docs), len(suppliers))
	for _, s := range suppliers {
		fmt.Fprintf(&text, "- %s: %d PDFs\n", s, counts[s])
	}
	fmt.Fprintf(&text, "\nDownload (%s link, expires in %d days):\n%s\n\n", cacheLabel(zipCached), int(ttl.Hours()/24), downloadURL)
	if portalURL != "" {
		fmt.Fprintf(&text, "Track the run in the portal: %s\n", portalURL)
	}
	text.WriteString("\nPaperTrail Fulfilment\n")

	var rows strings.Builder
	for _, s := range suppliers {
		fmt.Fprintf(&rows, `<tr><td style="padding:10px 14px;border-bottom:1px solid #ece9e2;color:#26323a">%s</td><td style="padding:10px 14px;border-bottom:1px solid #ece9e2;text-align:right;font-weight:600;color:#26323a">%d PDFs</td></tr>`, html.EscapeString(s), counts[s])
	}
	htmlBody := fmt.Sprintf(`<!doctype html>
<html><body style="margin:0;background:#f4f2ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d252c">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#1d252c;border-radius:18px 18px 0 0;padding:28px 32px;color:#f5f3ee">
    <div style="font-size:11px;letter-spacing:.18em;color:#9fc7b8;text-transform:uppercase">PaperTrail</div>
    <h1 style="margin:10px 0 4px;font-size:24px;line-height:1.2">Your PDF pack is ready</h1>
    <div style="font-size:13px;color:#c9c7c1">%s &middot; job %s</div>
  </div>
  <div style="background:#ffffff;padding:28px 32px;border-radius:0 0 18px 18px;border:1px solid #e7e3da;border-top:0">
    <p style="margin:0 0 18px;font-size:14px;color:#4a5054">%d documents are grouped into supplier folders inside one ZIP.</p>
    <table style="width:100%%;border-collapse:collapse;font-size:13px;border:1px solid #ece9e2;border-radius:12px;overflow:hidden">%s</table>
    <p style="margin:24px 0 8px"><a href="%s" style="display:inline-block;background:#1f7a5c;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:600;font-size:14px">Download ZIP (%s)</a></p>
    <p style="margin:0;font-size:12px;color:#7b807f">Link expires in %d days. Cached archives are reused when the same orders, revisions and statuses are requested again.</p>
  </div>
</div></body></html>`,
		html.EscapeString(job.ClientName), html.EscapeString(job.JobID), len(docs), rows.String(), html.EscapeString(downloadURL),
		cacheLabel(zipCached), int(ttl.Hours()/24))

	return subject, text.String(), htmlBody
}

func cacheLabel(cached bool) string {
	if cached {
		return "cached"
	}
	return "fresh"
}
