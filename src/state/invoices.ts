/*
 * Invoices and quotes: the sums, the numbers and the states, shared by the screens and the server. Money is whole
 * cents everywhere, and every total is worked out here from the lines, never typed in or taken from a model, so the
 * figures on the screen, in the PDF and in the email always agree.
 */
import type { BillingSettings, Invoice, InvoiceKind, LineItem } from '../data/ws-types';

export interface Totals {
  /** Each line's amount (quantity times price), in cents; 0 for an optional line that wasn't chosen. */
  lines: Record<string, number>;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

const round = (n: number) => Math.round(n + Number.EPSILON * Math.sign(n));

/** A line counts unless it is an optional one the client didn't choose. */
export const counts = (l: LineItem) => !l.optional || !!l.chosen;

/**
 * The sums. A line is quantity times price, rounded to the cent. A discount comes off the subtotal (a percentage, or
 * an amount no larger than the subtotal). Tax is each line's rate on that line after its share of the discount, so a
 * discount lowers the tax as it would on a till receipt. Rounded once per line.
 */
export function totals(inv: Pick<Invoice, 'items' | 'discount'>): Totals {
  const lines: Record<string, number> = {};
  let subtotal = 0;
  for (const l of inv.items) {
    const amount = counts(l) ? round(l.qty * l.unitPrice) : 0;
    lines[l.id] = amount;
    subtotal += amount;
  }
  const d = inv.discount;
  const discount = !d || subtotal <= 0 ? 0 : d.kind === 'percent' ? round((subtotal * Math.min(Math.max(d.value, 0), 100)) / 100) : Math.min(Math.max(round(d.value), 0), subtotal);
  const share = subtotal > 0 ? (subtotal - discount) / subtotal : 0;
  let tax = 0;
  for (const l of inv.items) if (counts(l) && l.taxRate) tax += round((lines[l.id]! * share * l.taxRate) / 100);
  return { lines, subtotal, discount, tax, total: subtotal - discount + tax };
}

/** "$1,234.50" (or the currency's own sign). */
export function money(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** Cents from what someone typed: "1,250", "$1250.5", "1250.50". Null when it isn't a number. */
export function centsFrom(typed: string): number | null {
  const clean = typed.replace(/[\s,$£€]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(clean) || clean === '' || clean === '-' || clean === '.') return null;
  return round(Number(clean) * 100);
}

/** What the screens show as an invoice's state, with the ones worked out from the date. */
export type ShownStatus = Invoice['status'] | 'overdue' | 'expired';

export function shownStatus(inv: Pick<Invoice, 'kind' | 'status' | 'due'>, now = new Date()): ShownStatus {
  const past = !!inv.due && new Date(inv.due).getTime() < now.getTime();
  if (inv.kind === 'invoice' && inv.status === 'sent' && past) return 'overdue';
  if (inv.kind === 'quote' && inv.status === 'sent' && past) return 'expired';
  return inv.status;
}

export const STATUS_LABEL: Record<ShownStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  accepted: 'Accepted',
  declined: 'Declined',
  void: 'Void',
  overdue: 'Overdue',
  expired: 'Expired',
};

/** The business details a workspace starts with: its name, the owner's address, Net 30, USD. */
export function defaultBilling(business: string, email?: string): BillingSettings {
  return { id: 'settings', business, ...(email ? { email } : {}), currency: 'USD', termsDays: 30, quoteDays: 30, invoicePrefix: 'INV-', quotePrefix: 'Q-', nextInvoice: 1, nextQuote: 1 };
}

/** "INV-0001". */
export const numberFor = (s: BillingSettings, kind: InvoiceKind) => `${kind === 'invoice' ? s.invoicePrefix : s.quotePrefix}${String(kind === 'invoice' ? s.nextInvoice : s.nextQuote).padStart(4, '0')}`;

const addDays = (d: Date, days: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  x.setHours(17, 0, 0, 0);
  return x;
};

/**
 * A new draft and the settings with its number used up. The number is taken now, so two drafts never share one; a
 * draft that is deleted leaves a gap, as it does in most accounting tools.
 */
export function newDraft(
  s: BillingSettings,
  kind: InvoiceKind,
  id: string,
  now: Date,
  fill: Partial<Pick<Invoice, 'client' | 'items' | 'project' | 'thread' | 'intro' | 'notes' | 'fromQuote' | 'by' | 'discount'>> = {},
): { invoice: Invoice; settings: BillingSettings } {
  const invoice: Invoice = {
    id,
    kind,
    number: numberFor(s, kind),
    status: 'draft',
    client: fill.client ?? { name: '' },
    issued: now,
    due: addDays(now, kind === 'invoice' ? s.termsDays : s.quoteDays),
    currency: s.currency,
    items: fill.items ?? [{ id: `${id}-1`, description: '', qty: 1, unitPrice: 0 }],
    ...(fill.discount ? { discount: fill.discount } : {}),
    ...(fill.intro ? { intro: fill.intro } : {}),
    ...(fill.notes ? { notes: fill.notes } : {}),
    terms: kind === 'invoice' ? (s.termsDays ? `Payment due within ${s.termsDays} days.` : 'Payment due on receipt.') : `This quote is valid for ${s.quoteDays} days.`,
    ...(fill.project ? { project: fill.project } : {}),
    ...(fill.thread ? { thread: fill.thread } : {}),
    ...(fill.fromQuote ? { fromQuote: fill.fromQuote } : {}),
    ...(fill.by ? { by: fill.by } : {}),
    created: now,
  };
  const settings = kind === 'invoice' ? { ...s, nextInvoice: s.nextInvoice + 1 } : { ...s, nextQuote: s.nextQuote + 1 };
  return { invoice, settings };
}

/** The email that carries an invoice or quote: what it is, the amount, the date, and how to pay. */
export function emailFor(inv: Invoice, s: BillingSettings, from: string): { subject: string; body: string } {
  const t = totals(inv);
  const first = inv.client.name.trim().split(/\s+/)[0] || 'there';
  const due = inv.due ? new Date(inv.due).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  if (inv.kind === 'quote') {
    return {
      subject: `Quote ${inv.number} from ${s.business}`,
      body: [`Hi ${first},`, `Here is quote ${inv.number} for ${money(t.total, inv.currency)}${due ? `, valid until ${due}` : ''}. The PDF is attached.`, 'Reply to this email to accept it, or with any questions.', `Thanks,\n${from}`].join('\n\n'),
    };
  }
  return {
    subject: `Invoice ${inv.number} from ${s.business}`,
    body: [`Hi ${first},`, `Here is invoice ${inv.number} for ${money(t.total, inv.currency)}${due ? `, due ${due}` : ''}. The PDF is attached.`, ...(s.payment ? [`How to pay:\n${s.payment}`] : []), `Thanks,\n${from}`].join('\n\n'),
  };
}
