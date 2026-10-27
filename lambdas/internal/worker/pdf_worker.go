package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"pdfdemo/lambdas/internal/cache"
	"pdfdemo/lambdas/internal/config"
	"pdfdemo/lambdas/internal/domain"
	"pdfdemo/lambdas/internal/pdf"
	"pdfdemo/lambdas/internal/store"
)

// PDFWorker turns one batch of orders into cached PDF documents.
type PDFWorker struct {
	cfg   config.Config
	store *store.Store
}

func NewPDFWorker(cfg config.Config, st *store.Store) *PDFWorker {
	return &PDFWorker{cfg: cfg, store: st}
}

// HandleMessage is the entry point shared by the Lambda handler and the local runner.
func (w *PDFWorker) HandleMessage(ctx context.Context, body []byte) error {
	var msg domain.BatchMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return fmt.Errorf("decode batch message: %w", err)
	}
	if msg.JobID == "" || msg.BatchIndex < 0 {
		return fmt.Errorf("invalid batch message: %s", string(body))
	}
	if err := w.process(ctx, msg); err != nil {
		slog.ErrorContext(ctx, "batch failed", "jobId", msg.JobID, "batch", msg.BatchIndex, "error", err)
		// Only fail the job if the batch itself did not complete. A failure after
		// completion is a finalise-publish retry and must not poison the job.
		batch, getErr := w.store.GetBatch(ctx, msg.JobID, msg.BatchIndex)
		if getErr == nil && batch.Status == domain.BatchDone {
			return err
		}
		_ = w.store.MarkBatchFailed(ctx, msg.JobID, msg.BatchIndex, err.Error())
		_ = w.store.MarkJobFailed(ctx, msg.JobID, err.Error())
		return err
	}
	return nil
}

func (w *PDFWorker) process(ctx context.Context, msg domain.BatchMessage) error {
	job, err := w.store.GetJob(ctx, msg.JobID)
	if errors.Is(err, store.ErrNotFound) {
		slog.WarnContext(ctx, "job missing, dropping message", "jobId", msg.JobID)
		return nil
	}
	if err != nil {
		return err
	}
	switch job.Status {
	case domain.JobRunning:
		// continue
	case domain.JobQueued:
		return fmt.Errorf("job %s not admitted yet", job.JobID)
	default:
		slog.InfoContext(ctx, "job no longer running, skipping batch", "jobId", job.JobID, "status", job.Status)
		return nil
	}

	batch, err := w.store.GetBatch(ctx, msg.JobID, msg.BatchIndex)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("batch %d not found for job %s", msg.BatchIndex, msg.JobID)
	}
	if err != nil {
		return err
	}
	if batch.Status == domain.BatchDone {
		return w.maybeFinalize(ctx, job)
	}
	if err := w.store.MarkBatchProcessing(ctx, job.JobID, batch.Index); err != nil {
		if errors.Is(err, store.ErrCondition) {
			return w.maybeFinalize(ctx, job)
		}
		return err
	}

	if len(batch.Orders) == 0 {
		return fmt.Errorf("batch %d has no order snapshot", batch.Index)
	}

	slog.InfoContext(ctx, "batch started", "jobId", job.JobID, "batch", batch.Index, "orders", len(batch.Orders))

	for _, order := range batch.Orders {
		if order.ClientID != job.ClientID {
			return fmt.Errorf("order %s belongs to %s, job is %s", order.ID, order.ClientID, job.ClientID)
		}
		bySupplier := order.ItemsBySupplier()
		for _, supplier := range order.Suppliers() {
			items := bySupplier[supplier]
			key := cache.PDFKey(order, supplier)
			fileName := cache.DocFileName(order.ID, supplier)

			exists, _, _, err := w.store.Head(ctx, key)
			if err != nil {
				return err
			}
			cached := exists
			if !exists {
				if err := sleepCtx(ctx, w.cfg.RenderDelay); err != nil {
					return err
				}
				data, err := pdf.Render(order, supplier, items)
				if err != nil {
					return err
				}
				metadata := map[string]string{
					"order-id":     order.ID,
					"client-id":    order.ClientID,
					"supplier":     supplier,
					"rev":          fmt.Sprint(order.Rev),
					"status":       order.Status,
					"content-hash": order.SupplierHash(supplier)[:16],
					"generated-at": time.Now().UTC().Format(time.RFC3339),
				}
				if err := w.store.PutBytes(ctx, key, "application/pdf", data, metadata); err != nil {
					return err
				}
				slog.InfoContext(ctx, "pdf rendered", "jobId", job.JobID, "order", order.ID, "supplier", supplier, "key", key, "bytes", len(data))
			}

			if err := w.store.AddBatchDocCounters(ctx, job.JobID, batch.Index, cached); err != nil && !errors.Is(err, store.ErrCondition) {
				return err
			}
			if err := w.store.AddJobDocCounters(ctx, job.JobID, cached); err != nil {
				if errors.Is(err, store.ErrCondition) {
					return fmt.Errorf("job %s stopped accepting progress (status changed)", job.JobID)
				}
				return err
			}
			batch.PDFsDone++
			if cached {
				batch.PDFsCached++
			} else {
				batch.PDFsGenerated++
			}
			batch.Docs = append(batch.Docs, domain.DocRef{
				OrderID:  order.ID,
				Supplier: supplier,
				Key:      key,
				FileName: fileName,
			})
		}
	}

	batch.Status = domain.BatchDone
	batch.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := w.store.CompleteBatch(ctx, job.JobID, batch); err != nil {
		if errors.Is(err, store.ErrCondition) {
			return w.maybeFinalize(ctx, job)
		}
		return err
	}

	done, err := w.store.IncrementBatchesDone(ctx, job.JobID)
	if err != nil {
		if errors.Is(err, store.ErrCondition) {
			slog.WarnContext(ctx, "could not increment batchesDone (job not running)", "jobId", job.JobID)
			return nil
		}
		return err
	}
	slog.InfoContext(ctx, "batch done", "jobId", job.JobID, "batch", batch.Index, "batchesDone", done, "batchCount", job.BatchCount)

	if done >= job.BatchCount {
		return w.publishFinalize(ctx, job)
	}
	return nil
}

func (w *PDFWorker) maybeFinalize(ctx context.Context, job *domain.Job) error {
	fresh, err := w.store.GetJob(ctx, job.JobID)
	if err != nil {
		return err
	}
	if fresh.Status == domain.JobRunning && fresh.BatchesDone >= fresh.BatchCount {
		return w.publishFinalize(ctx, fresh)
	}
	return nil
}

func (w *PDFWorker) publishFinalize(ctx context.Context, job *domain.Job) error {
	msg := domain.FinalizeMessage{Type: "pdf.finalize", JobID: job.JobID, ClientID: job.ClientID}
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := w.store.PublishFinalize(ctx, msg); err == nil {
			slog.InfoContext(ctx, "finalize queued", "jobId", job.JobID, "attempt", attempt)
			return nil
		} else {
			lastErr = err
			if err := sleepCtx(ctx, time.Duration(attempt)*300*time.Millisecond); err != nil {
				return err
			}
		}
	}
	return lastErr
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
