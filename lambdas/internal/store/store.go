package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ses"
	sestypes "github.com/aws/aws-sdk-go-v2/service/ses/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"

	"pdfdemo/lambdas/internal/config"
	"pdfdemo/lambdas/internal/domain"
)

var (
	ErrNotFound  = errors.New("item not found")
	ErrCondition = errors.New("condition failed")
)

type Store struct {
	cfg      config.Config
	DB       *dynamodb.Client
	S3       *s3.Client
	PublicS3 *s3.Client
	SES      *ses.Client
	SQS      *sqs.Client
}

func New(ctx context.Context, cfg config.Config) (*Store, error) {
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(cfg.Region)}
	if os.Getenv("AWS_ACCESS_KEY_ID") == "" && os.Getenv("AWS_PROFILE") == "" && isLocalEndpoint(cfg.Endpoint) {
		// LocalStack accepts any credentials. This keeps `go run ./cmd/devrunner`
		// working without exporting AWS env vars.
		opts = append(opts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider("test", "test", ""),
		))
	}
	awscfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	endpoint := func() *string {
		if cfg.Endpoint == "" {
			return nil
		}
		return aws.String(cfg.Endpoint)
	}

	s := &Store{cfg: cfg}
	s.DB = dynamodb.NewFromConfig(awscfg, func(o *dynamodb.Options) {
		o.BaseEndpoint = endpoint()
	})
	s.S3 = s3.NewFromConfig(awscfg, func(o *s3.Options) {
		o.BaseEndpoint = endpoint()
		o.UsePathStyle = true
	})
	public := cfg.PublicEndpoint
	if public == "" {
		public = cfg.Endpoint
	}
	s.PublicS3 = s3.NewFromConfig(awscfg, func(o *s3.Options) {
		if public != "" {
			o.BaseEndpoint = aws.String(public)
		}
		o.UsePathStyle = true
	})
	s.SES = ses.NewFromConfig(awscfg, func(o *ses.Options) {
		o.BaseEndpoint = endpoint()
	})
	s.SQS = sqs.NewFromConfig(awscfg, func(o *sqs.Options) {
		o.BaseEndpoint = endpoint()
	})
	return s, nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func jobKey(jobID string) map[string]ddbtypes.AttributeValue {
	return map[string]ddbtypes.AttributeValue{
		"pk": &ddbtypes.AttributeValueMemberS{Value: "JOB#" + jobID},
		"sk": &ddbtypes.AttributeValueMemberS{Value: "META"},
	}
}

func batchKey(jobID string, index int) map[string]ddbtypes.AttributeValue {
	return map[string]ddbtypes.AttributeValue{
		"pk": &ddbtypes.AttributeValueMemberS{Value: "JOB#" + jobID},
		"sk": &ddbtypes.AttributeValueMemberS{Value: fmt.Sprintf("BATCH#%04d", index)},
	}
}

type jobRecord struct {
	PK     string `dynamodbav:"pk"`
	SK     string `dynamodbav:"sk"`
	GSI1PK string `dynamodbav:"gsi1pk"`
	GSI1SK string `dynamodbav:"gsi1sk"`
	GSI2PK string `dynamodbav:"gsi2pk"`
	GSI2SK string `dynamodbav:"gsi2sk"`
	domain.Job
}

type batchRecord struct {
	PK string `dynamodbav:"pk"`
	SK string `dynamodbav:"sk"`
	domain.Batch
}

func (s *Store) GetJob(ctx context.Context, jobID string) (*domain.Job, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.cfg.Table),
		Key:            jobKey(jobID),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("get job: %w", err)
	}
	if len(out.Item) == 0 {
		return nil, ErrNotFound
	}
	var rec jobRecord
	if err := attributevalue.UnmarshalMap(out.Item, &rec); err != nil {
		return nil, fmt.Errorf("decode job: %w", err)
	}
	return &rec.Job, nil
}

func (s *Store) GetBatch(ctx context.Context, jobID string, index int) (*domain.Batch, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.cfg.Table),
		Key:            batchKey(jobID, index),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("get batch: %w", err)
	}
	if len(out.Item) == 0 {
		return nil, ErrNotFound
	}
	var rec batchRecord
	if err := attributevalue.UnmarshalMap(out.Item, &rec); err != nil {
		return nil, fmt.Errorf("decode batch: %w", err)
	}
	return &rec.Batch, nil
}

func (s *Store) ListBatches(ctx context.Context, jobID string) ([]domain.Batch, error) {
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.cfg.Table),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk":     &ddbtypes.AttributeValueMemberS{Value: "JOB#" + jobID},
			":prefix": &ddbtypes.AttributeValueMemberS{Value: "BATCH#"},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("list batches: %w", err)
	}
	batches := make([]domain.Batch, 0, len(out.Items))
	for _, item := range out.Items {
		var rec batchRecord
		if err := attributevalue.UnmarshalMap(item, &rec); err != nil {
			return nil, fmt.Errorf("decode batch: %w", err)
		}
		batches = append(batches, rec.Batch)
	}
	return batches, nil
}

func (s *Store) MarkBatchProcessing(ctx context.Context, jobID string, index int) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       batchKey(jobID, index),
		UpdateExpression: aws.String(
			"SET #st = :proc, startedAt = if_not_exists(startedAt, :now)",
		),
		ConditionExpression: aws.String("attribute_not_exists(#st) OR #st <> :done"),
		ExpressionAttributeNames: map[string]string{
			"#st": "status",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":proc": &ddbtypes.AttributeValueMemberS{Value: domain.BatchProcessing},
			":done": &ddbtypes.AttributeValueMemberS{Value: domain.BatchDone},
			":now":  &ddbtypes.AttributeValueMemberS{Value: now()},
		},
	})
	if err != nil && isCondition(err) {
		return ErrCondition
	}
	if err != nil {
		return fmt.Errorf("mark batch processing: %w", err)
	}
	return nil
}

func (s *Store) AddBatchDocCounters(ctx context.Context, jobID string, index int, cached bool) error {
	counter := "pdfsGenerated"
	if cached {
		counter = "pdfsCached"
	}
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       batchKey(jobID, index),
		UpdateExpression: aws.String(fmt.Sprintf(
			"ADD pdfsDone :one, %s :one", counter,
		)),
		ConditionExpression: aws.String("#st <> :done"),
		ExpressionAttributeNames: map[string]string{
			"#st": "status",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":one":  &ddbtypes.AttributeValueMemberN{Value: "1"},
			":done": &ddbtypes.AttributeValueMemberS{Value: domain.BatchDone},
		},
	})
	if err != nil && isCondition(err) {
		return ErrCondition
	}
	if err != nil {
		return fmt.Errorf("add batch counters: %w", err)
	}
	return nil
}

func (s *Store) AddJobDocCounters(ctx context.Context, jobID string, cached bool) error {
	counter := "pdfsGenerated"
	if cached {
		counter = "pdfsCached"
	}
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       jobKey(jobID),
		UpdateExpression: aws.String(fmt.Sprintf(
			"ADD pdfsDone :one, %s :one SET updatedAt = :now", counter,
		)),
		ConditionExpression: aws.String("#st = :running"),
		ExpressionAttributeNames: map[string]string{
			"#st": "status",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":one":     &ddbtypes.AttributeValueMemberN{Value: "1"},
			":running": &ddbtypes.AttributeValueMemberS{Value: domain.JobRunning},
			":now":     &ddbtypes.AttributeValueMemberS{Value: now()},
		},
	})
	if err != nil && isCondition(err) {
		return ErrCondition
	}
	if err != nil {
		return fmt.Errorf("add job counters: %w", err)
	}
	return nil
}

func (s *Store) CompleteBatch(ctx context.Context, jobID string, batch *domain.Batch) error {
	docs, err := attributevalue.Marshal(batch.Docs)
	if err != nil {
		return fmt.Errorf("encode docs: %w", err)
	}
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       batchKey(jobID, batch.Index),
		UpdateExpression: aws.String(
			"SET #st = :done, finishedAt = :now, pdfsDone = :pd, pdfsCached = :pc, pdfsGenerated = :pg, #docs = :docs",
		),
		ConditionExpression: aws.String("#st <> :done"),
		ExpressionAttributeNames: map[string]string{
			"#st":   "status",
			"#docs": "docs",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":done": &ddbtypes.AttributeValueMemberS{Value: domain.BatchDone},
			":now":  &ddbtypes.AttributeValueMemberS{Value: now()},
			":pd":   &ddbtypes.AttributeValueMemberN{Value: fmt.Sprint(batch.PDFsDone)},
			":pc":   &ddbtypes.AttributeValueMemberN{Value: fmt.Sprint(batch.PDFsCached)},
			":pg":   &ddbtypes.AttributeValueMemberN{Value: fmt.Sprint(batch.PDFsGenerated)},
			":docs": docs,
		},
	})
	if err != nil && isCondition(err) {
		return ErrCondition
	}
	if err != nil {
		return fmt.Errorf("complete batch: %w", err)
	}
	return nil
}

func (s *Store) IncrementBatchesDone(ctx context.Context, jobID string) (int, error) {
	out, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       jobKey(jobID),
		UpdateExpression: aws.String(
			"ADD batchesDone :one SET updatedAt = :now",
		),
		ConditionExpression: aws.String("#st = :running"),
		ExpressionAttributeNames: map[string]string{
			"#st": "status",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":one":     &ddbtypes.AttributeValueMemberN{Value: "1"},
			":running": &ddbtypes.AttributeValueMemberS{Value: domain.JobRunning},
			":now":     &ddbtypes.AttributeValueMemberS{Value: now()},
		},
		ReturnValues: ddbtypes.ReturnValueUpdatedNew,
	})
	if err != nil && isCondition(err) {
		return 0, ErrCondition
	}
	if err != nil {
		return 0, fmt.Errorf("increment batches done: %w", err)
	}
	var updated struct {
		BatchesDone int `dynamodbav:"batchesDone"`
	}
	if err := attributevalue.UnmarshalMap(out.Attributes, &updated); err != nil {
		return 0, fmt.Errorf("decode batches done: %w", err)
	}
	return updated.BatchesDone, nil
}

func (s *Store) MarkBatchFailed(ctx context.Context, jobID string, index int, message string) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       batchKey(jobID, index),
		UpdateExpression: aws.String(
			"SET #st = :failed, #err = :err, finishedAt = :now",
		),
		ConditionExpression: aws.String("#st <> :done"),
		ExpressionAttributeNames: map[string]string{
			"#st":  "status",
			"#err": "error",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":failed": &ddbtypes.AttributeValueMemberS{Value: domain.BatchFailed},
			":err":    &ddbtypes.AttributeValueMemberS{Value: message},
			":done":   &ddbtypes.AttributeValueMemberS{Value: domain.BatchDone},
			":now":    &ddbtypes.AttributeValueMemberS{Value: now()},
		},
	})
	if err != nil && isCondition(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("mark batch failed: %w", err)
	}
	return nil
}

func (s *Store) MarkJobFailed(ctx context.Context, jobID, message string) error {
	if len(message) > 900 {
		message = message[:900]
	}
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       jobKey(jobID),
		UpdateExpression: aws.String(
			"SET #st = :failed, gsi2pk = :gsi, #err = :err, finishedAt = :now",
		),
		ConditionExpression: aws.String("#st <> :completed AND #st <> :failed"),
		ExpressionAttributeNames: map[string]string{
			"#st":  "status",
			"#err": "error",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":failed":    &ddbtypes.AttributeValueMemberS{Value: domain.JobFailed},
			":completed": &ddbtypes.AttributeValueMemberS{Value: domain.JobCompleted},
			":gsi":       &ddbtypes.AttributeValueMemberS{Value: "STATUS#" + domain.JobFailed},
			":err":       &ddbtypes.AttributeValueMemberS{Value: message},
			":now":       &ddbtypes.AttributeValueMemberS{Value: now()},
		},
	})
	if err != nil && isCondition(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("mark job failed: %w", err)
	}
	return nil
}

func (s *Store) SetJobFinalizing(ctx context.Context, jobID string) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       jobKey(jobID),
		UpdateExpression: aws.String(
			"SET #st = :finalizing, gsi2pk = :gsi, startedAt = if_not_exists(startedAt, :now), updatedAt = :now",
		),
		ConditionExpression: aws.String("#st <> :completed AND #st <> :failed"),
		ExpressionAttributeNames: map[string]string{
			"#st": "status",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":finalizing": &ddbtypes.AttributeValueMemberS{Value: domain.JobFinalizing},
			":completed":  &ddbtypes.AttributeValueMemberS{Value: domain.JobCompleted},
			":failed":     &ddbtypes.AttributeValueMemberS{Value: domain.JobFailed},
			":gsi":        &ddbtypes.AttributeValueMemberS{Value: "STATUS#" + domain.JobFinalizing},
			":now":        &ddbtypes.AttributeValueMemberS{Value: now()},
		},
	})
	if err != nil && isCondition(err) {
		return ErrCondition
	}
	if err != nil {
		return fmt.Errorf("set job finalizing: %w", err)
	}
	return nil
}

type Completion struct {
	ZipKey         string
	ZipBytes       int64
	ZipCached      bool
	DownloadURL    string
	EmailMessageID string
	EmailError     string
	SupplierCounts map[string]int
	PDFsDone       int
}

func (s *Store) CompleteJob(ctx context.Context, jobID string, c Completion) error {
	counts, err := attributevalue.Marshal(c.SupplierCounts)
	if err != nil {
		return fmt.Errorf("encode supplier counts: %w", err)
	}
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.cfg.Table),
		Key:       jobKey(jobID),
		UpdateExpression: aws.String(
			"SET #st = :completed, gsi2pk = :gsi, zipKey = :zk, zipBytes = :zb, zipCached = :zc, downloadUrl = :url, emailMessageId = :mid, emailError = :ee, supplierCounts = :sc, pdfsDone = :pd, finishedAt = :now, updatedAt = :now",
		),
		ConditionExpression: aws.String("#st <> :completed"),
		ExpressionAttributeNames: map[string]string{
			"#st": "status",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":completed": &ddbtypes.AttributeValueMemberS{Value: domain.JobCompleted},
			":gsi":       &ddbtypes.AttributeValueMemberS{Value: "STATUS#" + domain.JobCompleted},
			":zk":        &ddbtypes.AttributeValueMemberS{Value: c.ZipKey},
			":zb":        &ddbtypes.AttributeValueMemberN{Value: fmt.Sprint(c.ZipBytes)},
			":zc":        &ddbtypes.AttributeValueMemberBOOL{Value: c.ZipCached},
			":url":       &ddbtypes.AttributeValueMemberS{Value: c.DownloadURL},
			":mid":       &ddbtypes.AttributeValueMemberS{Value: c.EmailMessageID},
			":ee":        &ddbtypes.AttributeValueMemberS{Value: c.EmailError},
			":sc":        counts,
			":pd":        &ddbtypes.AttributeValueMemberN{Value: fmt.Sprint(c.PDFsDone)},
			":now":       &ddbtypes.AttributeValueMemberS{Value: now()},
		},
	})
	if err != nil && isCondition(err) {
		return ErrCondition
	}
	if err != nil {
		return fmt.Errorf("complete job: %w", err)
	}
	return nil
}

func (s *Store) PublishFinalize(ctx context.Context, msg domain.FinalizeMessage) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode finalize message: %w", err)
	}
	_, err = s.SQS.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(s.cfg.FinalizeQueueURL),
		MessageBody: aws.String(string(body)),
	})
	if err != nil {
		return fmt.Errorf("send finalize message: %w", err)
	}
	return nil
}

func (s *Store) Head(ctx context.Context, key string) (bool, time.Time, int64, error) {
	out, err := s.S3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.cfg.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		if isNotFound(err) {
			return false, time.Time{}, 0, nil
		}
		return false, time.Time{}, 0, fmt.Errorf("head %s: %w", key, err)
	}
	var modified time.Time
	if out.LastModified != nil {
		modified = *out.LastModified
	}
	return true, modified, aws.ToInt64(out.ContentLength), nil
}

func (s *Store) PutBytes(ctx context.Context, key, contentType string, data []byte, metadata map[string]string) error {
	_, err := s.S3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.cfg.Bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader(data),
		ContentLength: aws.Int64(int64(len(data))),
		ContentType:   aws.String(contentType),
		Metadata:      metadata,
	})
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

func (s *Store) PutFile(ctx context.Context, key, contentType, contentDisposition, path string, metadata map[string]string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("open zip: %w", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, fmt.Errorf("stat zip: %w", err)
	}
	_, err = s.S3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:             aws.String(s.cfg.Bucket),
		Key:                aws.String(key),
		Body:               f,
		ContentLength:      aws.Int64(st.Size()),
		ContentType:        aws.String(contentType),
		ContentDisposition: aws.String(contentDisposition),
		Metadata:           metadata,
	})
	if err != nil {
		return 0, fmt.Errorf("put %s: %w", key, err)
	}
	return st.Size(), nil
}

func (s *Store) GetBytes(ctx context.Context, key string) ([]byte, error) {
	out, err := s.S3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.cfg.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	defer out.Body.Close()
	b, err := io.ReadAll(io.LimitReader(out.Body, 200<<20))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", key, err)
	}
	return b, nil
}

func (s *Store) PutJSON(ctx context.Context, key string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode json: %w", err)
	}
	_, err = s.S3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.cfg.Bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(b),
		ContentType: aws.String("application/json"),
	})
	if err != nil {
		return fmt.Errorf("put json %s: %w", key, err)
	}
	return nil
}

func (s *Store) PresignGet(ctx context.Context, key string) (string, error) {
	presigner := s3.NewPresignClient(s.PublicS3)
	out, err := presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.cfg.Bucket),
		Key:    aws.String(key),
	}, func(o *s3.PresignOptions) {
		o.Expires = s.cfg.PresignExpires
	})
	if err != nil {
		return "", fmt.Errorf("presign %s: %w", key, err)
	}
	return out.URL, nil
}

type EmailResult struct {
	MessageID string `json:"messageId"`
	SentAt    string `json:"sentAt"`
	Error     string `json:"error,omitempty"`
}

func (s *Store) SendEmail(ctx context.Context, to, subject, text, html string) (EmailResult, error) {
	out, err := s.SES.SendEmail(ctx, &ses.SendEmailInput{
		Source: aws.String(s.cfg.SESFrom),
		Destination: &sestypes.Destination{
			ToAddresses: []string{to},
		},
		Message: &sestypes.Message{
			Subject: &sestypes.Content{Data: aws.String(subject), Charset: aws.String("UTF-8")},
			Body: &sestypes.Body{
				Text: &sestypes.Content{Data: aws.String(text), Charset: aws.String("UTF-8")},
				Html: &sestypes.Content{Data: aws.String(html), Charset: aws.String("UTF-8")},
			},
		},
	})
	if err != nil {
		return EmailResult{SentAt: now(), Error: err.Error()}, fmt.Errorf("ses send: %w", err)
	}
	return EmailResult{MessageID: aws.ToString(out.MessageId), SentAt: now()}, nil
}

func isCondition(err error) bool {
	var ae *ddbtypes.ConditionalCheckFailedException
	if errors.As(err, &ae) {
		return true
	}
	var api smithy.APIError
	if errors.As(err, &api) {
		return api.ErrorCode() == "ConditionalCheckFailedException"
	}
	return false
}

func isNotFound(err error) bool {
	var api smithy.APIError
	if errors.As(err, &api) {
		code := api.ErrorCode()
		if code == "NotFound" || code == "NoSuchKey" || code == "NoSuchBucket" || code == "404" {
			return true
		}
	}
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) && re.HTTPStatusCode() == 404 {
		return true
	}
	return strings.Contains(err.Error(), "StatusCode: 404")
}

func isLocalEndpoint(endpoint string) bool {
	value := strings.ToLower(endpoint)
	return strings.Contains(value, "localhost") ||
		strings.Contains(value, "127.0.0.1") ||
		strings.Contains(value, "localstack")
}
