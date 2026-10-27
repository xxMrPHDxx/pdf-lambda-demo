package pdf

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"github.com/go-pdf/fpdf"

	"pdfdemo/lambdas/internal/domain"
)

// Render builds a deterministic, printable order sheet for one supplier slice.
func Render(order domain.Order, supplier string, items []domain.OrderItem) ([]byte, error) {
	doc := fpdf.New("P", "mm", "A4", "")
	doc.SetMargins(15, 16, 15)
	doc.SetAutoPageBreak(true, 20)
	doc.AliasNbPages("{nb}")
	doc.SetTitle(fmt.Sprintf("Order %s - %s", order.ID, supplier), false)
	doc.SetAuthor("PaperTrail Fulfilment", false)
	doc.SetCreator("pdf-lambda-demo", false)
	doc.SetSubject(fmt.Sprintf("rev %d / %s", order.Rev, order.Status), false)

	doc.SetFooterFunc(func() {
		doc.SetY(-14)
		doc.SetDrawColor(214, 211, 205)
		doc.Line(15, -12, 195, -12)
		doc.SetFont("Helvetica", "", 8)
		doc.SetTextColor(110, 108, 103)
		doc.CellFormat(120, 6, fmt.Sprintf("PaperTrail - Order %s - rev %d - %s", order.ID, order.Rev, strings.ToUpper(order.Status)), "", 0, "L", false, 0, "")
		doc.CellFormat(60, 6, fmt.Sprintf("Page %d/{nb}", doc.PageNo()), "", 0, "R", false, 0, "")
	})

	doc.AddPage()
	drawMasthead(doc, order, supplier)
	drawCustomer(doc, order)
	drawItems(doc, order, items)
	drawTotals(doc, order, items)

	var buf bytes.Buffer
	if err := doc.Output(&buf); err != nil {
		return nil, fmt.Errorf("render pdf: %w", err)
	}
	return buf.Bytes(), nil
}

func drawMasthead(doc *fpdf.Fpdf, order domain.Order, supplier string) {
	doc.SetFillColor(29, 37, 44)
	doc.Rect(0, 0, 210, 38, "F")

	doc.SetTextColor(245, 243, 238)
	doc.SetFont("Helvetica", "B", 19)
	doc.SetXY(15, 11)
	doc.CellFormat(120, 9, "ORDER FULFILMENT SHEET", "", 0, "L", false, 0, "")

	doc.SetFont("Helvetica", "", 10)
	doc.SetTextColor(178, 210, 198)
	doc.SetXY(15, 23)
	doc.CellFormat(120, 6, "PaperTrail - supplier dispatch pack", "", 0, "L", false, 0, "")

	doc.SetFont("Helvetica", "B", 11)
	doc.SetTextColor(245, 243, 238)
	doc.SetXY(135, 11)
	doc.CellFormat(60, 6, supplier, "", 0, "R", false, 0, "")

	doc.SetFont("Helvetica", "", 9)
	doc.SetTextColor(200, 198, 192)
	doc.SetXY(135, 19)
	doc.CellFormat(60, 5, fmt.Sprintf("%s  /  rev %d", strings.ToUpper(order.Status), order.Rev), "", 0, "R", false, 0, "")
	doc.SetXY(135, 24)
	doc.CellFormat(60, 5, order.ID, "", 0, "R", false, 0, "")
	doc.SetY(46)
}

func drawCustomer(doc *fpdf.Fpdf, order domain.Order) {
	doc.SetTextColor(38, 42, 47)
	doc.SetFont("Helvetica", "B", 9)
	doc.CellFormat(60, 5, "DELIVER TO", "", 1, "L", false, 0, "")
	doc.SetFont("Helvetica", "B", 11)
	doc.CellFormat(90, 6, order.Customer.Name, "", 1, "L", false, 0, "")
	doc.SetFont("Helvetica", "", 9)
	doc.SetTextColor(80, 82, 86)
	doc.MultiCell(90, 4.6, order.Customer.Address, "", "L", false)
	if order.Customer.Email != "" {
		doc.CellFormat(90, 4.6, order.Customer.Email, "", 1, "L", false, 0, "")
	}

	// Metadata block, right aligned.
	doc.SetXY(125, 46)
	doc.SetFont("Helvetica", "B", 9)
	doc.SetTextColor(38, 42, 47)
	doc.CellFormat(70, 5, "DOCUMENT DETAILS", "", 1, "R", false, 0, "")
	doc.SetFont("Helvetica", "", 9)
	doc.SetTextColor(80, 82, 86)
	doc.SetX(125)
	doc.CellFormat(70, 5, "Placed: "+displayDate(order.PlacedAt), "", 1, "R", false, 0, "")
	doc.SetX(125)
	doc.CellFormat(70, 5, "Currency: "+order.Currency, "", 1, "R", false, 0, "")
	doc.SetX(125)
	doc.CellFormat(70, 5, fmt.Sprintf("Revision: %d", order.Rev), "", 1, "R", false, 0, "")
	doc.Ln(5)
}

func drawItems(doc *fpdf.Fpdf, order domain.Order, items []domain.OrderItem) {
	widths := []float64{28, 82, 14, 28, 28}
	headers := []string{"SKU", "DESCRIPTION", "QTY", "UNIT", "LINE TOTAL"}
	drawTableHeader(doc, widths, headers)

	doc.SetFont("Helvetica", "", 9)
	for i, item := range items {
		if doc.GetY() > 255 {
			doc.AddPage()
			drawTableHeader(doc, widths, headers)
			doc.SetFont("Helvetica", "", 9)
		}
		if i%2 == 1 {
			doc.SetFillColor(247, 246, 243)
		} else {
			doc.SetFillColor(255, 255, 255)
		}
		lineTotal := float64(item.Qty) * item.UnitPrice
		values := []string{
			item.SKU,
			truncate(item.Description, 52),
			fmt.Sprintf("%d", item.Qty),
			money(order.Currency, item.UnitPrice),
			money(order.Currency, lineTotal),
		}
		aligns := []string{"L", "L", "R", "R", "R"}
		for c := range values {
			doc.SetTextColor(44, 47, 51)
			doc.CellFormat(widths[c], 8, values[c], "B", 0, aligns[c], true, 0, "")
		}
		doc.Ln(8)
	}
	doc.Ln(3)
}

func drawTableHeader(doc *fpdf.Fpdf, widths []float64, headers []string) {
	doc.SetFillColor(232, 230, 224)
	doc.SetTextColor(52, 56, 60)
	doc.SetFont("Helvetica", "B", 8)
	for i, h := range headers {
		align := "L"
		if i >= 2 {
			align = "R"
		}
		doc.CellFormat(widths[i], 8, h, "B", 0, align, true, 0, "")
	}
	doc.Ln(8)
}

func drawTotals(doc *fpdf.Fpdf, order domain.Order, items []domain.OrderItem) {
	var total float64
	for _, item := range items {
		total += float64(item.Qty) * item.UnitPrice
	}
	doc.SetFont("Helvetica", "", 9)
	doc.SetTextColor(80, 82, 86)
	doc.SetX(125)
	doc.CellFormat(42, 7, fmt.Sprintf("Items in this pack: %d", len(items)), "", 0, "R", false, 0, "")
	doc.CellFormat(28, 7, "", "", 1, "R", false, 0, "")

	doc.SetFillColor(29, 37, 44)
	doc.SetTextColor(245, 243, 238)
	doc.SetFont("Helvetica", "B", 11)
	doc.SetX(125)
	doc.CellFormat(42, 11, "PACK TOTAL", "", 0, "L", true, 0, "")
	doc.CellFormat(28, 11, money(order.Currency, total), "", 0, "R", true, 0, "")
	doc.Ln(16)

	doc.SetTextColor(90, 92, 96)
	doc.SetFont("Helvetica", "", 8)
	doc.MultiCell(180, 4.5,
		"Prices are shown in the order currency. This document was generated from the order revision and status printed above; later changes to the order produce a new document.",
		"", "L", false)
}

func money(currency string, amount float64) string {
	if currency == "" {
		currency = "USD"
	}
	return fmt.Sprintf("%s %.2f", currency, amount)
}

func displayDate(value string) string {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return parsed.UTC().Format("02 Jan 2006")
}

func truncate(value string, max int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= max {
		return string(runes)
	}
	return string(runes[:max-1]) + "..."
}
