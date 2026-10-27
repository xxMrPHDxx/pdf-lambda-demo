package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"time"

	"pdfdemo/lambdas/internal/domain"
)

// PDFKey returns the content-addressed S3 key for one order/supplier PDF.
// Rev, status and item content are all part of the hash, so external edits
// never serve a stale document.
func PDFKey(order domain.Order, supplier string) string {
	hash := order.SupplierHash(supplier)[:16]
	return fmt.Sprintf(
		"pdfs/%s/%s/%s/%d-%s-%s.pdf",
		domain.Slug(order.ClientID),
		domain.Slug(order.ID),
		domain.Slug(supplier),
		order.Rev,
		domain.Slug(order.Status),
		hash,
	)
}

// DocFileName is the human-readable file name stored inside the ZIP.
func DocFileName(orderID, supplier string) string {
	return fmt.Sprintf("%s-%s.pdf", domain.Slug(orderID), domain.Slug(supplier))
}

// FilterHash fingerprints a whole selection so identical selections reuse the ZIP.
func FilterHash(orders []domain.Order) string {
	sigs := make([]string, 0, len(orders))
	for _, o := range orders {
		sigs = append(sigs, o.Signature())
	}
	sort.Strings(sigs)
	h := sha256.New()
	for _, s := range sigs {
		fmt.Fprintf(h, "%s\n", s)
	}
	return hex.EncodeToString(h.Sum(nil))[:24]
}

// ZipKey builds the cache key for a selection-level ZIP.
func ZipKey(clientID, filterHash string) string {
	return fmt.Sprintf("zips/%s/%s.zip", domain.Slug(clientID), filterHash)
}

// EmailKey is where the demo stores a copy of the SES message for preview.
func EmailKey(jobID string) string {
	return fmt.Sprintf("emails/%s.json", jobID)
}

// ZipIsFresh reports whether a cached ZIP is still inside its reuse window.
func ZipIsFresh(lastModified, now time.Time, ttl time.Duration) bool {
	if lastModified.IsZero() {
		return false
	}
	if now.Before(lastModified) {
		// Clock skew: treat as fresh rather than rebuilding.
		return true
	}
	return now.Sub(lastModified) < ttl
}
