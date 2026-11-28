/**
 * An invoice or quote as a PDF, the file that goes out with its email and that the person downloads. Every figure
 * comes from totals() in src/state/invoices.ts, the same sums the screen shows. Letter size, Helvetica, one column of
 * lines that runs onto more pages when it has to. Nothing in it is taken from a model.
 */
import PDFDocument from 'pdfkit';
import type { BillingSettings, Invoice } from '../../../src/data/ws-types';
import { money, payUrl, totals } from '../../../src/state/invoices';

const INK = '#1d2230';
const SOFT = '#5d6475';
const LINE = '#d9dce3';
const MARGIN = 54;

const day = (d?: Date | string) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

export async function invoicePdf(inv: Invoice, s: BillingSettings): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, info: { Title: `${inv.kind === 'invoice' ? 'Invoice' : 'Quote'} ${inv.number}`, Author: s.business, Creator: 'Timmy' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  const width = doc.page.width - MARGIN * 2;
  const right = doc.page.width - MARGIN;
  const t = totals(inv);
  const cur = inv.currency;

  // The business, left; what this is and its number, right.
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(s.business || ' ', MARGIN, MARGIN, { width: width / 2 });
  doc.font('Helvetica').fontSize(9).fillColor(SOFT);
  for (const line of [s.address, s.email, s.phone, s.taxId].filter(Boolean) as string[]) doc.text(line, { width: width / 2 });
  const headTop = MARGIN;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text(inv.kind === 'invoice' ? 'INVOICE' : 'QUOTE', MARGIN + width / 2, headTop, { width: width / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(SOFT);
  const meta: [string, string][] = [
    ['Number', inv.number],
    ['Issued', day(inv.issued)],
    ...(inv.due ? [[inv.kind === 'invoice' ? 'Due' : 'Valid until', day(inv.due)] as [string, string]] : []),
  ];
  for (const [k, v] of meta) doc.text(`${k}  ${v}`, MARGIN + width / 2, undefined, { width: width / 2, align: 'right' });
  doc.y = Math.max(doc.y, 150);

  // Who it is for.
  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(SOFT).text(inv.kind === 'invoice' ? 'BILL TO' : 'PREPARED FOR', MARGIN);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(inv.client.name || ' ');
  doc.font('Helvetica').fontSize(9).fillColor(SOFT);
  for (const line of [inv.client.company, inv.client.address, inv.client.email].filter(Boolean) as string[]) doc.text(line, { width: width / 2 });
  if (inv.intro) {
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(inv.intro, MARGIN, undefined, { width });
  }

  // The lines.
  doc.moveDown(1.2);
  const cols = { desc: MARGIN, qty: MARGIN + width * 0.56, price: MARGIN + width * 0.66, tax: MARGIN + width * 0.8, amount: MARGIN + width * 0.86 };
  const header = () => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(SOFT);
    doc.text('DESCRIPTION', cols.desc, y, { width: width * 0.54 });
    doc.text('QTY', cols.qty, y, { width: width * 0.09, align: 'right' });
    doc.text('PRICE', cols.price, y, { width: width * 0.13, align: 'right' });
    doc.text('TAX', cols.tax, y, { width: width * 0.05, align: 'right' });
    doc.text('AMOUNT', cols.amount, y, { width: right - cols.amount, align: 'right' });
    doc.moveTo(MARGIN, doc.y + 4).lineTo(right, doc.y + 4).strokeColor(LINE).lineWidth(0.8).stroke();
    doc.y += 10;
  };
  header();
  for (const l of inv.items) {
    const desc = `${l.description || ' '}${l.optional ? (l.chosen ? '  (optional, included)' : '  (optional, not included)') : ''}`;
    doc.font('Helvetica').fontSize(10);
    const h = Math.max(doc.heightOfString(desc, { width: width * 0.54 }), 12);
    if (doc.y + h + 8 > doc.page.height - MARGIN - 120) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    doc.fillColor(l.optional && !l.chosen ? SOFT : INK).text(desc, cols.desc, y, { width: width * 0.54 });
    doc.text(qtyText(l.qty), cols.qty, y, { width: width * 0.09, align: 'right' });
    doc.text(money(l.unitPrice, cur), cols.price, y, { width: width * 0.13, align: 'right' });
    doc.text(l.taxRate ? `${l.taxRate}%` : '', cols.tax, y, { width: width * 0.05, align: 'right' });
    doc.text(money(t.lines[l.id] ?? 0, cur), cols.amount, y, { width: right - cols.amount, align: 'right' });
    doc.y = y + h + 6;
    doc.moveTo(MARGIN, doc.y).lineTo(right, doc.y).strokeColor(LINE).lineWidth(0.4).stroke();
    doc.y += 6;
  }

  // The totals, right.
  doc.moveDown(0.6);
  const sum = (label: string, value: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? INK : SOFT);
    doc.text(label, MARGIN + width * 0.55, y, { width: width * 0.25, align: 'right' });
    doc.fillColor(INK).text(value, MARGIN + width * 0.8, y, { width: width * 0.2, align: 'right' });
    doc.moveDown(0.35);
  };
  sum('Subtotal', money(t.subtotal, cur));
  if (t.discount) sum(inv.discount?.kind === 'percent' ? `Discount (${inv.discount.value}%)` : 'Discount', `-${money(t.discount, cur)}`);
  if (t.tax) sum('Tax', money(t.tax, cur));
  sum(inv.kind === 'invoice' ? 'Amount due' : 'Total', money(t.total, cur), true);

  // Notes, terms and how to pay.
  const block = (title: string, body?: string) => {
    if (!body?.trim()) return;
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(SOFT).text(title.toUpperCase(), MARGIN, undefined, { width });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(body, { width });
  };
  block('Notes', inv.notes);
  block('Terms', inv.terms);
  // The "Pay online" link, when the invoice has a good one: printed in full (a printed copy can still be typed in)
  // and clickable in the file.
  const online = payUrl(inv);
  if (online) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(SOFT).text('PAY ONLINE BY CARD', MARGIN, undefined, { width });
    doc.font('Helvetica').fontSize(9.5).fillColor('#2457c5').text(online, { width, link: online, underline: true });
    doc.fillColor(INK);
  }
  if (inv.kind === 'invoice') block(online ? 'Or pay' : 'How to pay', s.payment);

  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

/** The file's name: "Invoice INV-0001 – Northpeak.pdf". */
export const pdfName = (inv: Invoice, s: BillingSettings) => `${inv.kind === 'invoice' ? 'Invoice' : 'Quote'} ${inv.number} – ${s.business}.pdf`.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
