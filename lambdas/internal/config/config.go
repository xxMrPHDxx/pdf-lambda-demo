package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the runtime configuration shared by both workers.
type Config struct {
	Region            string
	Endpoint          string
	PublicEndpoint    string
	Bucket            string
	Table             string
	BatchQueueURL     string
	FinalizeQueueURL  string
	SESFrom           string
	PortalURL         string
	WorkerConcurrency int
	RenderDelay       time.Duration
	ZipCacheTTL       time.Duration
	PDFCacheDays      int
	PresignExpires    time.Duration
	SaveEmailToS3     bool
}

func Load() Config {
	return Config{
		Region:            env("AWS_REGION", "us-east-1"),
		Endpoint:          env("AWS_ENDPOINT_URL", "http://localhost:4566"),
		PublicEndpoint:    env("S3_PUBLIC_ENDPOINT", "http://localhost:4566"),
		Bucket:            env("S3_BUCKET", "pdf-demo"),
		Table:             env("DDB_TABLE", "pdf-demo"),
		BatchQueueURL:     env("SQS_BATCH_QUEUE", "http://localhost:4566/000000000000/pdf-demo-batches"),
		FinalizeQueueURL:  env("SQS_FINALIZE_QUEUE", "http://localhost:4566/000000000000/pdf-demo-finalize"),
		SESFrom:           env("SES_FROM", "orders@pdfdemo.local"),
		PortalURL:         env("PORTAL_URL", "http://localhost:8080"),
		WorkerConcurrency: intEnv("WORKER_CONCURRENCY", 5),
		RenderDelay:       time.Duration(intEnv("PDF_RENDER_DELAY_MS", 150)) * time.Millisecond,
		ZipCacheTTL:       time.Duration(intEnv("ZIP_CACHE_HOURS", 3)) * time.Hour,
		PDFCacheDays:      intEnv("PDF_CACHE_DAYS", 7),
		PresignExpires:    time.Duration(intEnv("PRESIGN_EXPIRES_SECONDS", 604800)) * time.Second,
		SaveEmailToS3:     boolEnv("SES_SAVE_TO_S3", true),
	}
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func intEnv(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func boolEnv(key string, fallback bool) bool {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return fallback
}
