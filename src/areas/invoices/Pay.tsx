/*
 * Getting paid online: the business's own Stripe account (Business details), and an invoice's "Pay online" link.
 * The link is made on the business's Stripe account when the invoice is sent (or when asked for here), goes in the
 * email and the PDF, and the invoice is marked paid when Stripe says so. Card details are typed on Stripe's page,
 * never in Timmy. In the sample demo, Stripe counts as connected and the links go nowhere.
 */
import { Copy, CreditCard, ExternalLink, Link2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { Invoice } from '../../data/ws-types';
import { api } from '../../live/api';
import { isLive } from '../../live/clock';
import { money, payUrl, samplePay, totals } from '../../state/invoices';
import { useStore } from '../../state/store';
import { refreshPayments, usePayments } from './payments';

const dayText = (d?: Date | string) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/** Countries the business can be registered in, as Stripe's form asks (it confirms the choice). */
const COUNTRIES: [string, string][] = [
  ['US', 'United States'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
  ['IE', 'Ireland'],
  ['AU', 'Australia'],
  ['NZ', 'New Zealand'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['NL', 'Netherlands'],
];
const BY_CURRENCY: Record<string, string> = { USD: 'US', CAD: 'CA', GBP: 'GB', AUD: 'AU', NZD: 'NZ', EUR: 'IE' };

/** Business details › Get paid online. */
export function StripeCard({ currency }: { currency: string }) {
  const { dispatch } = useStore();
  const p = usePayments();
  const [country, setCountry] = useState(BY_CURRENCY[currency] ?? 'US');
  const [busy, setBusy] = useState(false);
  const toast = (text: string, tone?: 'warn') => dispatch({ type: 'toast', text, ...(tone ? { tone } : {}) });
  const connect = async () => {
    setBusy(true);
    try {
      const r = await api.connectStripe(country);
      // Stripe's own page, where the business says who it is and where the money goes. It comes back here.
      window.location.assign(r.url);
    } catch (e) {
      toast((e as Error).message, 'warn');
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnectStripe();
      await refreshPayments();
      toast('Stripe is disconnected. New invoices carry your “how to pay” text only; links already sent still work.');
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };
  const checkAgain = async () => {
    setBusy(true);
    const r = await refreshPayments(true);
    setBusy(false);
    if (r.stripe === 'ready') toast('Card payments are on.');
  };
  let body;
  if (p.sample) body = <p className="muted">In the sample, Stripe counts as connected: each invoice gets a sample “Pay online” link that goes nowhere. On your own workspace the money goes into your own Stripe account.</p>;
  else if (!p.known) body = <p className="muted">Checking…</p>;
  else if (!p.on) body = <p className="muted">Card payments aren’t set up on this server yet. Until they are, invoices carry your “how clients pay you” text.</p>;
  else if (p.stripe === 'ready')
    body = (
      <>
        <p>
          <strong>Card payments are on.</strong> Each invoice you send carries a “Pay online” link. Your client pays on Stripe’s page, the money goes into your Stripe account, and Timmy marks the invoice paid when Stripe says so. Stripe’s fee comes off each payment; Timmy takes nothing.
        </p>
        <div className="pay-actions">
          <a className="btn btn-sm" href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer">
            <ExternalLink size={13} /> Open Stripe
          </a>
          {p.canConnect && (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          )}
        </div>
      </>
    );
  else if (p.stripe === 'checking')
    body = (
      <>
        <p>Stripe is checking your details. Card payments switch on when it’s done, usually within minutes.</p>
        <div className="pay-actions">
          <button className="btn btn-sm" disabled={busy} onClick={() => void checkAgain()}>
            <RefreshCw size={13} /> Check again
          </button>
        </div>
      </>
    );
  else if (!p.canConnect) body = <p className="muted">An owner or admin connects the Stripe account your invoices are paid into.</p>;
  else
    body = (
      <>
        <p>{p.stripe === 'started' ? 'Stripe still needs a few details from you before it can take card payments.' : 'Let clients pay by card from the invoice. You connect your own Stripe account (or make one in a few minutes); the money goes straight to it.'}</p>
        <div className="pay-actions">
          {p.stripe === 'none' && (
            <label className="pay-country">
              <span className="field-label">Where your business is registered</span>
              <select className="input" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
                {COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={() => void connect()}>
            <CreditCard size={14} /> {busy ? 'Opening Stripe…' : p.stripe === 'started' ? 'Carry on with Stripe' : 'Connect Stripe'}
          </button>
        </div>
      </>
    );
  return (
    <div className="card pay-card" aria-label="Get paid online">
      <h2 className="section-title">
        <CreditCard size={16} aria-hidden /> Get paid online
      </h2>
      {body}
    </div>
  );
}

/** An invoice's payment link, and what Stripe has said about it. */
export function PayRow({ inv, onBeforeAction }: { inv: Invoice; onBeforeAction: () => void }) {
  const { dispatch } = useStore();
  const p = usePayments();
  const [busy, setBusy] = useState<'link' | 'check' | null>(null);
  if (inv.kind !== 'invoice') return null;
  const toast = (text: string, tone?: 'warn') => dispatch({ type: 'toast', text, ...(tone ? { tone } : {}) });
  const url = payUrl(inv);
  const pay = inv.pay;
  const add = async () => {
    onBeforeAction();
    if (!isLive()) {
      dispatch({ type: 'samplePayLink', id: inv.id });
      return;
    }
    setBusy('link');
    try {
      await api.invoicePayLink(inv.id);
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy('check');
    try {
      const r = await api.invoicePayCheck(inv.id);
      if (!r.paid && !r.clearing) toast('Stripe has no payment for it yet.');
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setBusy(null);
    }
  };
  const copy = () => {
    if (!url) return;
    navigator.clipboard?.writeText(url).then(
      () => toast('Payment link copied'),
      () => toast('Couldn’t copy it. Select the link and copy it instead.', 'warn'),
    );
  };
  if (pay?.paid)
    return (
      <div className="pay-row pay-row-paid" role="status">
        <CreditCard size={14} aria-hidden /> Paid online {dayText(pay.paid.at)}: {money(pay.paid.amount, pay.currency)} through Stripe.
      </div>
    );
  if (inv.status === 'paid' || inv.status === 'void') return null;
  if (pay?.clearing)
    return (
      <div className="pay-row" role="status">
        <CreditCard size={14} aria-hidden /> {inv.client.name || 'Your client'} started a bank payment {dayText(pay.clearing)}. It clears in a few days; Timmy marks the invoice paid then.
        {isLive() && (
          <button className="link-btn" disabled={busy === 'check'} onClick={() => void check()}>
            <RefreshCw size={13} aria-hidden /> Check Stripe
          </button>
        )}
      </div>
    );
  if (url)
    return (
      <div className="pay-row" aria-label="Payment link">
        <Link2 size={14} aria-hidden />
        <span className="muted">Pay online</span>
        <a className="pay-url" href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>
        <button className="link-btn" onClick={copy}>
          <Copy size={13} aria-hidden /> Copy
        </button>
        {isLive() && inv.status === 'sent' && (
          <button className="link-btn" disabled={busy === 'check'} onClick={() => void check()}>
            <RefreshCw size={13} aria-hidden /> {busy === 'check' ? 'Asking Stripe…' : 'Check Stripe'}
          </button>
        )}
        {pay?.sample && inv.status === 'sent' && (
          <button className="link-btn" onClick={() => dispatch({ type: 'invoicePayment', id: inv.id, event: 'paid', at: new Date(), amount: totals(inv).total, currency: inv.currency, ref: 'sample' })}>
            Sample: the client pays
          </button>
        )}
      </div>
    );
  if (p.stripe === 'ready')
    return (
      <div className="pay-row">
        <Link2 size={14} aria-hidden />
        <span className="muted">{pay ? 'The total changed since its payment link was made.' : 'Sending it adds a “Pay online” link.'}</span>
        <button className="link-btn" disabled={busy === 'link' || totals(inv).total <= 0} onClick={() => void add()}>
          {busy === 'link' ? 'Making it…' : pay ? 'Make a new link' : 'Make the link now'}
        </button>
      </div>
    );
  if (p.on && p.stripe === 'none' && p.canConnect)
    return (
      <div className="pay-row">
        <CreditCard size={14} aria-hidden />
        <span className="muted">Let clients pay this by card.</span>
        <button className="link-btn" onClick={() => dispatch({ type: 'navigate', route: { view: 'invoices', tab: 'details' } })}>
          Connect Stripe
        </button>
      </div>
    );
  return null;
}

/**
 * Before an invoice is sent: its payment link, made if it needs one. Returns the address, or null when there is
 * none to give (card payments off, or Stripe refused, which the person is told; the email goes without it).
 */
export async function linkForSending(inv: Invoice, ready: boolean, dispatch: ReturnType<typeof useStore>['dispatch']): Promise<string | null> {
  if (inv.kind !== 'invoice' || !ready || inv.status === 'paid' || inv.status === 'void' || totals(inv).total <= 0) return null;
  const have = payUrl(inv);
  if (have) return have;
  if (!isLive()) {
    dispatch({ type: 'samplePayLink', id: inv.id });
    return samplePay(inv, new Date()).url;
  }
  try {
    return (await api.invoicePayLink(inv.id)).url;
  } catch (e) {
    dispatch({ type: 'toast', text: `No payment link this time: ${(e as Error).message} The email goes without it.`, tone: 'warn' });
    return null;
  }
}
