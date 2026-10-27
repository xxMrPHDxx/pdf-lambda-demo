package domain

import (
	"reflect"
	"testing"
)

func TestSuppliersAndGrouping(t *testing.T) {
	o := Order{Items: []OrderItem{
		{Supplier: "Zeta", SKU: "B"},
		{Supplier: "Alpha", SKU: "C"},
		{Supplier: "Zeta", SKU: "A"},
	}}
	suppliers := o.Suppliers()
	if !reflect.DeepEqual(suppliers, []string{"Alpha", "Zeta"}) {
		t.Fatalf("suppliers not sorted: %v", suppliers)
	}
	groups := o.ItemsBySupplier()
	if len(groups["Zeta"]) != 2 || groups["Zeta"][0].SKU != "A" {
		t.Fatalf("items not grouped/sorted: %v", groups["Zeta"])
	}
	if o.DocumentCount() != 2 {
		t.Fatalf("document count: %d", o.DocumentCount())
	}
}

func TestSupplierHashIgnoresItemOrder(t *testing.T) {
	o := Order{
		ID: "AC-1", ClientID: "acme", Rev: 1, Status: StatusPaid, Currency: "USD",
		Items: []OrderItem{
			{SKU: "A", Description: "a", Qty: 1, UnitPrice: 2, Supplier: "S"},
			{SKU: "B", Description: "b", Qty: 2, UnitPrice: 3, Supplier: "S"},
		},
	}
	h1 := o.SupplierHash("S")
	o.Items[0], o.Items[1] = o.Items[1], o.Items[0]
	if o.SupplierHash("S") != h1 {
		t.Fatal("hash must be stable under item reordering")
	}
	o.Status = StatusPacking
	if o.SupplierHash("S") == h1 {
		t.Fatal("hash must change with status")
	}
}

func TestSafeFolder(t *testing.T) {
	cases := map[string]string{
		"Nordic Paper Co.":   "Nordic Paper Co",
		"A/B:C*D?E\"F<G>H|I": "A-B-C-D-E-F-G-H-I",
		"   ":                "Supplier",
		"..":                 "Supplier",
	}
	for input, want := range cases {
		if got := SafeFolder(input); got != want {
			t.Errorf("SafeFolder(%q) = %q, want %q", input, got, want)
		}
	}
}
