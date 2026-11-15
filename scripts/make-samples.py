"""Sample files for the demo workspace (public/samples): the PDFs attached to
seeded emails and one real .docx, .xlsx and .pptx per project, so each Craft
viewer has a genuine file to open. Run: python3 scripts/make-samples.py"""
from pathlib import Path

from docx import Document
from docx.shared import Pt
from openpyxl import Workbook
from openpyxl.styles import Font
from pptx import Presentation
from pptx.util import Inches, Pt as PPt
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, PageBreak

OUT = Path(__file__).resolve().parent.parent / "public" / "samples"
OUT.mkdir(parents=True, exist_ok=True)
ss = getSampleStyleSheet()
H1, H2, BODY = ss["Title"], ss["Heading2"], ss["BodyText"]
SMALL = ParagraphStyle("small", parent=BODY, fontSize=8.5, textColor=colors.HexColor("#555555"))
GRID = TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#BFBFBF")),
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F1F1")),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTSIZE", (0, 0), (-1, -1), 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
])


def pdf(name, title, story, author="Northpeak"):
    doc = SimpleDocTemplate(str(OUT / name), pagesize=letter, title=title, author=author,
                            leftMargin=0.9 * inch, rightMargin=0.9 * inch, topMargin=0.9 * inch, bottomMargin=0.9 * inch)
    doc.build(story)


def table(rows, widths=None):
    t = Table([[Paragraph(str(c), BODY) for c in r] for r in rows], colWidths=widths, repeatRows=1)
    t.setStyle(GRID)
    return t


# ── Acme MSA redlines ─────────────────────────────────────────────
ins = lambda t: f'<font color="#1f5fbf"><u>{t}</u></font>'
dele = lambda t: f'<font color="#b3261e"><strike>{t}</strike></font>'
msa = [
    Paragraph("Master Services Agreement", H1),
    Paragraph("Acme Corp and Northpeak, Inc. · Redlines from Acme Legal, November 12, 2026", SMALL),
    Spacer(1, 12),
    Paragraph(f"Changes from Acme are shown as {ins('insertions')} and {dele('deletions')}.", BODY),
    Paragraph("1. Term", H2),
    Paragraph(f"This Agreement starts on {dele('December 1, 2026')} {ins('January 1, 2027')} and continues for twelve (12) months, renewing for successive one-year terms unless either party gives {dele('thirty (30)')} {ins('sixty (60)')} days’ written notice.", BODY),
    Paragraph("2. Fees and payment", H2),
    Paragraph(f"Customer pays the fees in the Order Form annually in advance. Invoices are due {dele('net thirty (30)')} {ins('net forty-five (45)')} days from receipt.", BODY),
    Paragraph("3. Limitation of liability", H2),
    Paragraph(f"Each party’s total liability is limited to the fees paid in the {dele('six (6)')} {ins('twelve (12)')} months before the claim. {ins('The cap does not apply to breaches of Section 5 (Data Protection).')}", BODY),
    Paragraph("4. Security", H2),
    Paragraph(f"Northpeak maintains SOC 2 Type II controls{ins(' and provides its most recent report on request')}. Single sign-on (SAML) is included at the Business tier and above.", BODY),
    Paragraph("5. Data protection", H2),
    Paragraph(f"Northpeak processes Customer Data only on Customer’s documented instructions{ins(', under the Data Processing Addendum attached as Exhibit B')}. {dele('Sub-processors may be changed at any time.')} {ins('Northpeak gives thirty (30) days’ notice before adding a sub-processor.')}", BODY),
    PageBreak(),
    Paragraph("Open questions for Northpeak Legal", H2),
    table([["#", "Section", "Acme’s ask", "Owner"],
           ["1", "3. Liability", "Uncapped liability for data protection breaches", "Hannah Ito"],
           ["2", "5. Data protection", "30 days’ notice of new sub-processors", "Hannah Ito"],
           ["3", "2. Payment", "Net 45 instead of net 30", "Ben Carter"]], [0.4 * inch, 1.4 * inch, 3.2 * inch, 1.3 * inch]),
]
pdf("acme-msa.pdf", "Acme MSA redlines", msa, "Acme Legal")

# ── Acme stakeholder map ─────────────────────────────────────────
pdf("acme-stakeholders.pdf", "Acme stakeholder map", [
    Paragraph("Acme Corp — Renewal stakeholders", H1),
    Paragraph("Shared by Dana Whitfield, November 6, 2026", SMALL), Spacer(1, 14),
    table([["Name", "Role", "In the decision", "What they care about"],
           ["Mark Chen", "CFO", "Signs off on the renewal", "Total annual cost; price per seat at volume"],
           ["Dana Whitfield", "Head of Procurement", "Owns the process and the quote", "Short emails with the numbers up front"],
           ["Raj Patel", "IT Director", "Security and SSO review", "SAML SSO included, SOC 2 report"],
           ["Grace Liu", "Operations Manager", "Day-to-day admin", "Seat changes mid-year"]],
          [1.3 * inch, 1.3 * inch, 1.7 * inch, 2.4 * inch]),
    Spacer(1, 14),
    Paragraph("Timeline: quote to CFO Wednesday, Nov 18 · approval by Friday, Nov 20 · start January 1, 2027.", BODY),
], "Acme Corp")

# ── Receipts ─────────────────────────────────────────────────────
def receipt(name, title, merchant, lines, total, meta):
    rows = [["Item", "Amount"]] + lines + [["Total", total]]
    t = Table(rows, colWidths=[4.6 * inch, 1.5 * inch])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black), ("LINEABOVE", (0, -1), (-1, -1), 0.6, colors.black),
                           ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                           ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("TOPPADDING", (0, 0), (-1, -1), 6)]))
    pdf(name, title, [Paragraph(merchant, H1), Paragraph(meta, SMALL), Spacer(1, 16), t, Spacer(1, 16),
                      Paragraph("Paid with Northpeak corporate card ending 4417. Thank you.", SMALL)], merchant)

receipt("harbor-receipt.pdf", "Harbor Grill receipt", "Harbor Grill",
        [["Dinner for 4 (client: Acme Corp)", "$152.00"], ["Tax", "$13.40"], ["Tip", "$21.00"]], "$186.40",
        "October 21, 2026, 9:38 PM · Table 12 · Receipt #HG-20481")
receipt("figma-receipt.pdf", "Figma receipt", "Figma",
        [["Figma Professional · 1 editor · November", "$45.00"]], "$45.00",
        "November 15, 2026 · Invoice #FIG-7733912 · Billed to Northpeak, Inc.")

# ── Brightwave order form (countersigned) ────────────────────────
pdf("att-brightwave.pdf", "Brightwave order form", [
    Paragraph("Order Form", H1), Paragraph("Northpeak, Inc. and Brightwave · Countersigned November 15, 2026", SMALL), Spacer(1, 14),
    table([["Product", "Quantity", "Price", "Annual total"],
           ["Northpeak Business (annual)", "50 seats", "$60 / seat / month", "$36,000"]], [2.4 * inch, 1.1 * inch, 1.5 * inch, 1.3 * inch]),
    Spacer(1, 14),
    Paragraph("Term: December 1, 2026 to November 30, 2027. Billed annually in advance, net 30.", BODY),
    Spacer(1, 30),
    table([["For Northpeak", "For Brightwave"], ["Taylor Morgan, Account Executive", "Elena Rossi, Procurement"], ["Signed Nov 13, 2026", "Signed Nov 15, 2026"]], [3.1 * inch, 3.1 * inch]),
], "Brightwave")

# ── Pricing report with a chart ──────────────────────────────────
d = Drawing(440, 200)
bc = VerticalBarChart()
bc.x, bc.y, bc.height, bc.width = 40, 30, 150, 380
bc.data = [[44, 61], [9, 7]]
bc.categoryAxis.categoryNames = ["2025", "2026"]
bc.valueAxis.valueMin, bc.valueAxis.valueMax, bc.valueAxis.valueStep = 0, 70, 10
bc.bars[0].fillColor = colors.HexColor("#3f51d9")
bc.bars[1].fillColor = colors.HexColor("#e9971a")
d.add(bc)
pdf("att-pricing-report.pdf", "State of B2B SaaS Pricing 2026", [
    Paragraph("State of B2B SaaS Pricing 2026", H1), Paragraph("Pricing Weekly · 400 companies surveyed", SMALL), Spacer(1, 12),
    Paragraph("Headline findings", H2),
    Paragraph("61% of B2B SaaS companies now combine a seat price with a usage component, up from 44% last year. "
              "The median discount at 100+ seats fell from 9% to 7% as buyers traded discounts for longer terms.", BODY),
    Spacer(1, 8), d,
    Paragraph("Blue: share with hybrid seat-plus-usage pricing (%). Orange: median discount at 100+ seats (%).", SMALL),
    Paragraph("What it means for renewals", H2),
    Paragraph("Volume tiers still close deals, but buyers expect them published. Annual prepay and two-year terms are the "
              "most common trades for a deeper discount.", BODY),
], "Pricing Weekly")

# ── Acme order form (.docx) ──────────────────────────────────────
doc = Document()
doc.core_properties.title = "Acme order form (draft)"
doc.core_properties.author = "Taylor Morgan"
doc.add_heading("Order Form — Acme Corp", 0)
doc.add_paragraph("Draft for CFO review · prepared November 16, 2026 by Taylor Morgan, Northpeak")
doc.add_heading("Subscription", level=1)
t = doc.add_table(rows=1, cols=4)
t.style = "Table Grid"
for i, h in enumerate(["Product", "Seats", "Price per seat per month", "Annual total"]):
    t.rows[0].cells[i].text = h
row = t.add_row().cells
for i, v in enumerate(["Northpeak Business (annual)", "120", "$58", "$83,520"]):
    row[i].text = v
doc.add_heading("Terms", level=1)
for line in ["Term: January 1, 2027 to December 31, 2027.", "Billing: annually in advance, net 30.",
             "Single sign-on (SAML) is included at this tier; no separate add-on.",
             "Seats can be added at the same per-seat price during the term."]:
    doc.add_paragraph(line, style="List Bullet")
doc.add_heading("Signatures", level=1)
doc.add_paragraph("For Acme Corp: ______________________   Date: __________")
doc.add_paragraph("For Northpeak: ______________________   Date: __________")
for p in doc.paragraphs:
    for r in p.runs:
        r.font.size = r.font.size or Pt(11)
doc.save(OUT / "acme-order-form.docx")

# ── Northwind pilot budget (.xlsx) ───────────────────────────────
wb = Workbook()
ws = wb.active
ws.title = "Pilot budget"
ws.append(["Line item", "Quantity", "Unit price", "Months", "Total"])
for c in ws[1]:
    c.font = Font(bold=True)
items = [("Pilot seats", 25, 50, 3), ("Onboarding sessions", 4, 400, 1), ("Data migration", 1, 1800, 1), ("Premium support", 1, 300, 3)]
for i, (name, q, price, months) in enumerate(items, start=2):
    ws.append([name, q, price, months, f"=B{i}*C{i}*D{i}"])
    ws[f"C{i}"].number_format = '"$"#,##0'
    ws[f"E{i}"].number_format = '"$"#,##0'
last = len(items) + 1
ws.append(["Total", None, None, None, f"=SUM(E2:E{last})"])
ws[f"A{last + 1}"].font = Font(bold=True)
ws[f"E{last + 1}"].font = Font(bold=True)
ws[f"E{last + 1}"].number_format = '"$"#,##0'
for col, w in zip("ABCDE", (24, 10, 12, 9, 12)):
    ws.column_dimensions[col].width = w
ws.freeze_panes = "A2"
wb.save(OUT / "northwind-budget.xlsx")

# ── Hiring loop deck (.pptx) ─────────────────────────────────────
prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = "Platform Engineer — Interview loop"
s.placeholders[1].text = "Hiring · Platform team · Q4 2026"
for title, bullets in [
    ("The loop", ["Recruiter screen (30 min) · Sofia", "Systems design (60 min)", "Debugging pairing session (60 min)", "Team lunch: collaboration read", "Debrief within 24 hours"]),
    ("What we score", ["Systems design: trade-offs, failure modes", "Debugging: hypotheses, narrowing down", "Collaboration: how they use feedback", "Ownership: follow-through on open questions"]),
    ("Timeline", ["Two hires by January", "Offers out within a week of the debrief", "Scorecards due before every debrief"]),
]:
    sl = prs.slides.add_slide(prs.slide_layouts[1])
    sl.shapes.title.text = title
    body = sl.placeholders[1].text_frame
    body.text = bullets[0]
    for b in bullets[1:]:
        body.add_paragraph().text = b
prs.core_properties.title = "Platform Engineer interview loop"
prs.save(OUT / "hiring-loop.pptx")

print("\n".join(sorted(f"{p.name} {p.stat().st_size}" for p in OUT.iterdir())))
