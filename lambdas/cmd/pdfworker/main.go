package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	"pdfdemo/lambdas/internal/config"
	"pdfdemo/lambdas/internal/store"
	"pdfdemo/lambdas/internal/worker"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	cfg := config.Load()
	st, err := store.New(context.Background(), cfg)
	if err != nil {
		slog.Error("init store", "error", err)
		os.Exit(1)
	}
	w := worker.NewPDFWorker(cfg, st)
	if cfg.BatchQueueURL == "" {
		slog.Warn("SQS_BATCH_QUEUE is empty; finalise publishing will fail")
	}

	lambda.Start(func(ctx context.Context, ev events.SQSEvent) (events.SQSEventResponse, error) {
		var failures []events.SQSBatchItemFailure
		for _, record := range ev.Records {
			if err := w.HandleMessage(ctx, []byte(record.Body)); err != nil {
				slog.Error("batch item failed", "messageId", record.MessageId, "error", err)
				failures = append(failures, events.SQSBatchItemFailure{ItemIdentifier: record.MessageId})
			}
		}
		return events.SQSEventResponse{BatchItemFailures: failures}, nil
	})
}
