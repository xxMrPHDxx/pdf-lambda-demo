// Command devrunner emulates an SQS event source mapping on LocalStack.
// It runs the same handlers as the Lambda entrypoints, just with long polling.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"pdfdemo/lambdas/internal/config"
	"pdfdemo/lambdas/internal/finalizer"
	"pdfdemo/lambdas/internal/store"
	"pdfdemo/lambdas/internal/worker"
)

type messageHandler interface {
	HandleMessage(ctx context.Context, body []byte) error
}

func main() {
	role := flag.String("role", "pdfworker", "pdfworker or zipper")
	concurrency := flag.Int("concurrency", envIntFallback("WORKER_CONCURRENCY", 5), "concurrent messages per process")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	cfg := config.Load()
	// devrunner is the local-only SQS consumer, so default it to LocalStack.
	if cfg.Endpoint == "" {
		cfg.Endpoint = "http://localhost:4566"
	}
	if cfg.PublicEndpoint == "" {
		cfg.PublicEndpoint = "http://localhost:4566"
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg)
	if err != nil {
		slog.Error("init store", "error", err)
		os.Exit(1)
	}

	var (
		handler  messageHandler
		queueURL string
		visSecs  int32
	)
	switch *role {
	case "pdfworker":
		handler = worker.NewPDFWorker(cfg, st)
		queueURL = cfg.BatchQueueURL
		visSecs = 180
	case "zipper":
		handler = finalizer.NewZipWorker(cfg, st)
		queueURL = cfg.FinalizeQueueURL
		visSecs = 300
	default:
		slog.Error("unknown role", "role", *role)
		os.Exit(1)
	}
	if queueURL == "" {
		slog.Error("queue URL is empty", "role", *role)
		os.Exit(1)
	}

	slog.Info("devrunner started", "role", *role, "queue", queueURL, "concurrency", *concurrency)
	for i := 0; i < *concurrency; i++ {
		go pollLoop(ctx, st.SQS, queueURL, visSecs, handler, i)
	}
	<-ctx.Done()
	slog.Info("devrunner stopping", "role", *role)
	time.Sleep(300 * time.Millisecond)
}

func pollLoop(ctx context.Context, client *sqs.Client, queueURL string, visibility int32, handler messageHandler, id int) {
	for ctx.Err() == nil {
		out, err := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:            aws.String(queueURL),
			MaxNumberOfMessages: 1,
			// Short polling on purpose: LocalStack's long-poll implementation can
			// reserve a message for a poller that has already gone away, which
			// leaves the message invisible for the whole visibility timeout.
			WaitTimeSeconds:   2,
			VisibilityTimeout: visibility,
		})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("sqs receive failed", "poller", id, "error", err)
			sleep(ctx, 2*time.Second)
			continue
		}
		if len(out.Messages) == 0 {
			sleep(ctx, 250*time.Millisecond)
			continue
		}
		for _, msg := range out.Messages {
			if msg.Body == nil {
				continue
			}
			start := time.Now()
			if err := handler.HandleMessage(ctx, []byte(*msg.Body)); err != nil {
				slog.Error("message failed (will retry)", "poller", id, "messageId", aws.ToString(msg.MessageId), "error", err)
				continue
			}
			_, err := client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
				QueueUrl:      aws.String(queueURL),
				ReceiptHandle: msg.ReceiptHandle,
			})
			if err != nil {
				slog.Error("sqs delete failed", "poller", id, "messageId", aws.ToString(msg.MessageId), "error", err)
				continue
			}
			slog.Info("message processed", "poller", id, "messageId", aws.ToString(msg.MessageId), "ms", time.Since(start).Milliseconds())
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func envIntFallback(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}
