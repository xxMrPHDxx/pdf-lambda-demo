package finalizer

import (
	"testing"

	"pdfdemo/lambdas/internal/domain"
)

func TestUniqueFolderAndName(t *testing.T) {
	used := map[string]bool{}
	if got := uniqueFolder("Nordic", used); got != "Nordic" {
		t.Fatalf("got %s", got)
	}
	if got := uniqueFolder("Nordic", used); got != "Nordic (2)" {
		t.Fatalf("got %s", got)
	}
	names := map[string]bool{}
	if got := uniqueName("AC-1-nordic.pdf", names); got != "AC-1-nordic.pdf" {
		t.Fatalf("got %s", got)
	}
	if got := uniqueName("AC-1-nordic.pdf", names); got != "AC-1-nordic-2.pdf" {
		t.Fatalf("got %s", got)
	}
}

func TestCountBySupplier(t *testing.T) {
	docs := []domain.DocRef{
		{OrderID: "AC-1", Supplier: "Nordic"},
		{OrderID: "AC-2", Supplier: "Nordic"},
		{OrderID: "AC-3", Supplier: "Atlas"},
	}
	counts := countBySupplier(docs)
	if counts["Nordic"] != 2 || counts["Atlas"] != 1 {
		t.Fatalf("counts: %v", counts)
	}
}
