package cache

import (
	"strings"
	"testing"
	"time"

	"pdfdemo/lambdas/internal/domain"
)

func sampleOrder() domain.Order {
	return domain.Order{
		ID:       "AC-1001",
		ClientID: "acme",
		Rev:      3,
		Status:   domain.StatusConfirmed,
		Currency: "USD",
		PlacedAt: "2026-10-01",
		Customer: domain.Customer{Name: "Ada Lovelace"},
		Items: []domain.OrderItem{
			{SKU: "NP-A4", Description: "A4 paper", Qty: 10, UnitPrice: 4.5, Supplier: "Nordic Paper Co."},
			{SKU: "AT-9", Description: "Gloves", Qty: 2, UnitPrice: 12, Supplier: "Atlas Industrial"},
			{SKU: "NP-A5", Description: "A5 paper", Qty: 5, UnitPrice: 3, Supplier: "Nordic Paper Co."},
		},
	}
}

func TestPDFKeyIncludesRevisionStatusAndContent(t *testing.T) {
	o := sampleOrder()
	base := PDFKey(o, "Nordic Paper Co.")
	if !strings.Contains(base, "/3-confirmed-") {
		t.Fatalf("key missing rev/status: %s", base)
	}
	if !strings.Contains(base, "nordic-paper-co") {
		t.Fatalf("key missing supplier slug: %s", base)
	}

	changedRev := o
	changedRev.Rev++
	if PDFKey(changedRev, "Nordic Paper Co.") == base {
		t.Fatal("rev change must produce a new key")
	}

	changedStatus := o
	changedStatus.Status = domain.StatusShipped
	if PDFKey(changedStatus, "Nordic Paper Co.") == base {
		t.Fatal("status change must produce a new key")
	}

	changedQty := o
	changedQty.Items = append([]domain.OrderItem(nil), o.Items...)
	changedQty.Items[0].Qty = 11
	if PDFKey(changedQty, "Nordic Paper Co.") == base {
		t.Fatal("quantity change must produce a new key")
	}

	otherSupplier := PDFKey(o, "Atlas Industrial")
	if otherSupplier == base {
		t.Fatal("suppliers must not share keys")
	}
}

func TestFilterHashStableAcrossOrdering(t *testing.T) {
	a := sampleOrder()
	b := sampleOrder()
	b.ID = "AC-1002"
	b.Items = append(b.Items, domain.OrderItem{SKU: "HX-1", Description: "Cable", Qty: 1, UnitPrice: 5, Supplier: "Helios Electronics"})

	h1 := FilterHash([]domain.Order{a, b})
	h2 := FilterHash([]domain.Order{b, a})
	if h1 != h2 {
		t.Fatalf("filter hash must be order-independent: %s != %s", h1, h2)
	}

	b.Rev++
	if FilterHash([]domain.Order{a, b}) == h1 {
		t.Fatal("filter hash must change when an order revision changes")
	}
}

func TestZipKey(t *testing.T) {
	key := ZipKey("Acme Retail", "abc123")
	if key != "zips/acme-retail/abc123.zip" {
		t.Fatalf("unexpected zip key: %s", key)
	}
}

func TestZipFreshness(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	ttl := 3 * time.Hour
	if ZipIsFresh(time.Time{}, now, ttl) {
		t.Fatal("zero time must not be fresh")
	}
	if !ZipIsFresh(now.Add(-2*time.Hour), now, ttl) {
		t.Fatal("zip inside TTL must be fresh")
	}
	if ZipIsFresh(now.Add(-4*time.Hour), now, ttl) {
		t.Fatal("zip outside TTL must be stale")
	}
	if !ZipIsFresh(now.Add(5*time.Minute), now, ttl) {
		t.Fatal("clock skew should be treated as fresh")
	}
}
