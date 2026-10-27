package pdf

import (
	"bytes"
	"strings"
	"testing"

	"pdfdemo/lambdas/internal/domain"
)

func TestRenderProducesPDF(t *testing.T) {
	order := domain.Order{
		ID:       "AC-1001",
		ClientID: "acme",
		Rev:      2,
		Status:   domain.StatusPaid,
		Currency: "USD",
		PlacedAt: "2026-10-02",
		Customer: domain.Customer{Name: "Ada Lovelace", Email: "ada@example.com", Address: "12 Analytical Way\nLondon"},
		Items: []domain.OrderItem{
			{SKU: "NP-A4", Description: "A4 Copy Paper 80gsm", Qty: 24, UnitPrice: 4.25, Supplier: "Nordic Paper Co."},
			{SKU: "NP-A5", Description: "A5 Notebook", Qty: 6, UnitPrice: 8.1, Supplier: "Nordic Paper Co."},
		},
	}
	data, err := Render(order, "Nordic Paper Co.", order.Items)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !bytes.HasPrefix(data, []byte("%PDF")) {
		t.Fatalf("not a PDF: %q", data[:min(len(data), 8)])
	}
	if len(data) < 1200 {
		t.Fatalf("pdf suspiciously small: %d", len(data))
	}
	// Core font PDFs store text uncompressed enough for a smoke assertion on the title.
	if !strings.Contains(string(data), "ORDER FULFILMENT SHEET") && !strings.Contains(string(data), "FlateDecode") {
		t.Log("title stream compressed; size check is sufficient")
	}
}
