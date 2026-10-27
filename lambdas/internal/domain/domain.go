package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// Order statuses used by the demo catalog.
const (
	StatusConfirmed = "confirmed"
	StatusPaid      = "paid"
	StatusPacking   = "packing"
	StatusShipped   = "shipped"
)

// Job statuses.
const (
	JobQueued     = "QUEUED"
	JobRunning    = "RUNNING"
	JobFinalizing = "FINALIZING"
	JobCompleted  = "COMPLETED"
	JobFailed     = "FAILED"
)

// Batch statuses.
const (
	BatchPending    = "PENDING"
	BatchProcessing = "PROCESSING"
	BatchDone       = "DONE"
	BatchFailed     = "FAILED"
)

type Customer struct {
	Name    string `json:"name" dynamodbav:"name"`
	Email   string `json:"email" dynamodbav:"email"`
	Address string `json:"address" dynamodbav:"address"`
}

type OrderItem struct {
	SKU         string  `json:"sku" dynamodbav:"sku"`
	Description string  `json:"description" dynamodbav:"description"`
	Qty         int     `json:"qty" dynamodbav:"qty"`
	UnitPrice   float64 `json:"unitPrice" dynamodbav:"unitPrice"`
	Supplier    string  `json:"supplier" dynamodbav:"supplier"`
}

type Order struct {
	ID       string      `json:"id" dynamodbav:"id"`
	ClientID string      `json:"clientId" dynamodbav:"clientId"`
	Rev      int         `json:"rev" dynamodbav:"rev"`
	Status   string      `json:"status" dynamodbav:"status"`
	Currency string      `json:"currency" dynamodbav:"currency"`
	PlacedAt string      `json:"placedAt" dynamodbav:"placedAt"`
	Customer Customer    `json:"customer" dynamodbav:"customer"`
	Items    []OrderItem `json:"items" dynamodbav:"items"`
}

type Catalog struct {
	Version   int      `json:"version" dynamodbav:"version"`
	UpdatedAt string   `json:"updatedAt" dynamodbav:"updatedAt"`
	Clients   []Client `json:"clients" dynamodbav:"clients"`
	Orders    []Order  `json:"orders" dynamodbav:"orders"`
}

type Client struct {
	ID       string `json:"id" dynamodbav:"id"`
	Name     string `json:"name" dynamodbav:"name"`
	Email    string `json:"email" dynamodbav:"email"`
	Initials string `json:"initials" dynamodbav:"initials"`
}

// BatchMessage is the SQS payload for a unit of PDF work.
type BatchMessage struct {
	Type       string   `json:"type"`
	JobID      string   `json:"jobId"`
	ClientID   string   `json:"clientId"`
	BatchIndex int      `json:"batchIndex"`
	OrderIDs   []string `json:"orderIds"`
}

// FinalizeMessage is the SQS payload that starts ZIP creation.
type FinalizeMessage struct {
	Type     string `json:"type"`
	JobID    string `json:"jobId"`
	ClientID string `json:"clientId"`
}

// DocRef is the authoritative record of a rendered PDF, written by a batch worker.
type DocRef struct {
	OrderID  string `json:"orderId" dynamodbav:"orderId"`
	Supplier string `json:"supplier" dynamodbav:"supplier"`
	Key      string `json:"key" dynamodbav:"key"`
	FileName string `json:"fileName" dynamodbav:"fileName"`
}

// Job mirrors the DynamoDB job row (excluding keys).
type Job struct {
	JobID         string         `json:"jobId" dynamodbav:"jobId"`
	ClientID      string         `json:"clientId" dynamodbav:"clientId"`
	ClientName    string         `json:"clientName" dynamodbav:"clientName"`
	Email         string         `json:"email" dynamodbav:"email"`
	Status        string         `json:"status" dynamodbav:"status"`
	CreatedAt     string         `json:"createdAt" dynamodbav:"createdAt"`
	StartedAt     string         `json:"startedAt" dynamodbav:"startedAt"`
	FinishedAt    string         `json:"finishedAt" dynamodbav:"finishedAt"`
	Error         string         `json:"error" dynamodbav:"error"`
	OrderIDs      []string       `json:"orderIds" dynamodbav:"orderIds"`
	BatchSize     int            `json:"batchSize" dynamodbav:"batchSize"`
	BatchCount    int            `json:"batchCount" dynamodbav:"batchCount"`
	BatchesDone   int            `json:"batchesDone" dynamodbav:"batchesDone"`
	PDFsTotal     int            `json:"pdfsTotal" dynamodbav:"pdfsTotal"`
	PDFsDone      int            `json:"pdfsDone" dynamodbav:"pdfsDone"`
	PDFsCached    int            `json:"pdfsCached" dynamodbav:"pdfsCached"`
	PDFsGenerated int            `json:"pdfsGenerated" dynamodbav:"pdfsGenerated"`
	FilterHash    string         `json:"filterHash" dynamodbav:"filterHash"`
	ZipKey        string         `json:"zipKey" dynamodbav:"zipKey"`
	ZipBytes      int64          `json:"zipBytes" dynamodbav:"zipBytes"`
	ZipCached     bool           `json:"zipCached" dynamodbav:"zipCached"`
	DownloadURL   string         `json:"downloadUrl" dynamodbav:"downloadUrl"`
	EmailMessage  string         `json:"emailMessageId" dynamodbav:"emailMessageId"`
	EmailError    string         `json:"emailError" dynamodbav:"emailError"`
	SupplierCount map[string]int `json:"supplierCounts" dynamodbav:"supplierCounts"`
}

// Batch mirrors the DynamoDB batch row (excluding keys).
type Batch struct {
	JobID         string   `json:"jobId" dynamodbav:"jobId"`
	Index         int      `json:"index" dynamodbav:"batchIndex"`
	Status        string   `json:"status" dynamodbav:"status"`
	OrderIDs      []string `json:"orderIds" dynamodbav:"orderIds"`
	Orders        []Order  `json:"orders" dynamodbav:"orders"`
	PDFsTotal     int      `json:"pdfsTotal" dynamodbav:"pdfsTotal"`
	PDFsDone      int      `json:"pdfsDone" dynamodbav:"pdfsDone"`
	PDFsCached    int      `json:"pdfsCached" dynamodbav:"pdfsCached"`
	PDFsGenerated int      `json:"pdfsGenerated" dynamodbav:"pdfsGenerated"`
	StartedAt     string   `json:"startedAt" dynamodbav:"startedAt"`
	FinishedAt    string   `json:"finishedAt" dynamodbav:"finishedAt"`
	Error         string   `json:"error" dynamodbav:"error"`
	Docs          []DocRef `json:"docs" dynamodbav:"docs"`
}

// Suppliers returns the sorted distinct supplier names in the order.
func (o Order) Suppliers() []string {
	seen := make(map[string]struct{}, len(o.Items))
	for _, it := range o.Items {
		seen[it.Supplier] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// ItemsBySupplier groups items, sorting each group by SKU for deterministic output.
func (o Order) ItemsBySupplier() map[string][]OrderItem {
	out := make(map[string][]OrderItem)
	for _, it := range o.Items {
		out[it.Supplier] = append(out[it.Supplier], it)
	}
	for s := range out {
		items := out[s]
		sort.Slice(items, func(i, j int) bool {
			if items[i].SKU == items[j].SKU {
				return items[i].Description < items[j].Description
			}
			return items[i].SKU < items[j].SKU
		})
		out[s] = items
	}
	return out
}

// SupplierHash hashes the cache-relevant content of one supplier slice of an order.
// Rev and status are included so any external change invalidates the PDF key.
func (o Order) SupplierHash(supplier string) string {
	items := o.ItemsBySupplier()[supplier]
	sort.Slice(items, func(i, j int) bool {
		if items[i].SKU == items[j].SKU {
			return items[i].Description < items[j].Description
		}
		return items[i].SKU < items[j].SKU
	})
	h := sha256.New()
	fmt.Fprintf(h, "order=%s\nclient=%s\nrev=%d\nstatus=%s\nsupplier=%s\ncurrency=%s\n", o.ID, o.ClientID, o.Rev, o.Status, supplier, o.Currency)
	for _, it := range items {
		fmt.Fprintf(h, "%s\x1f%s\x1f%d\x1f%.4f\n", it.SKU, it.Description, it.Qty, it.UnitPrice)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Signature is the order-level cache fingerprint used in the ZIP filter hash.
func (o Order) Signature() string {
	parts := []string{fmt.Sprintf("%s|%d|%s", o.ID, o.Rev, o.Status)}
	for _, s := range o.Suppliers() {
		parts = append(parts, s+":"+o.SupplierHash(s)[:16])
	}
	return strings.Join(parts, "|")
}

// DocumentCount is the number of PDFs (order × supplier) this order will produce.
func (o Order) DocumentCount() int {
	return len(o.Suppliers())
}

// Slug produces an S3-safe token.
func Slug(in string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(in)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "supplier"
	}
	return out
}

// SafeFolder sanitises a supplier name for use as a folder inside the ZIP.
func SafeFolder(supplier string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-", "\"", "-", "<", "-", ">", "-", "|", "-")
	out := strings.TrimSpace(replacer.Replace(supplier))
	out = strings.Trim(out, " .")
	if out == "" {
		return "Supplier"
	}
	return out
}
