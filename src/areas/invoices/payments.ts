/**
 * Whether invoices can carry a "Pay online" link: in the sample demo, always (with a sample link that goes nowhere);
 * on a real workspace, when the server has Stripe set up and the business has connected its own Stripe account.
 * Asked once per page load and shared; asked again after connecting, disconnecting or coming back from Stripe.
 */
import { useEffect, useState } from 'react';
import { api, type PaymentsStatus } from '../../live/api';
import { isLive } from '../../live/clock';

export type Payments = PaymentsStatus & { sample: boolean; known: boolean };

const SAMPLE: Payments = { on: true, stripe: 'ready', canConnect: true, sample: true, known: true };
const OFF: PaymentsStatus = { on: false, stripe: 'none', canConnect: false };

let known: PaymentsStatus | null = null;
let asking: Promise<PaymentsStatus> | null = null;
const listeners = new Set<(s: PaymentsStatus) => void>();

/** Asks the server again (after Connect, Disconnect, or the way back from Stripe) and tells every screen showing it. `askStripe` has the server ask Stripe first. */
export function refreshPayments(askStripe = false): Promise<PaymentsStatus> {
  asking = api.paymentsStatus(askStripe).catch(() => OFF);
  return asking.then((r) => {
    known = r;
    for (const l of listeners) l(r);
    return r;
  });
}

export function usePayments(): Payments {
  const [s, setS] = useState<PaymentsStatus | null>(() => (isLive() ? known : null));
  useEffect(() => {
    if (!isLive()) return;
    listeners.add(setS);
    if (!known) (asking ?? refreshPayments()).then(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  if (!isLive()) return SAMPLE;
  return s ? { ...s, sample: false, known: true } : { ...OFF, sample: false, known: false };
}
