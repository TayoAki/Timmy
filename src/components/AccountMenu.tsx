/*
 * The person's own icon, in the bottom-left corner of the bottom bar (under the left rail): it opens a small card
 * saying who is signed in and in which workspace, with Rules & settings and Sign out. On a phone the icon is the first
 * tab of the tab bar and opens the same card in a sheet (AccountTab). The sample demo shows its made-up person and has
 * nothing to sign out of.
 */
import { LogOut, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PEOPLE } from '../data/mock';
import { useProfile } from '../live/LiveApp';
import { useStore } from '../state/store';
import { Avatar } from './common';

const SAMPLE = { name: 'Taylor Morgan', email: 'taylor@northpeak.io', workspace: 'Northpeak (sample)' };
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Who is signed in, as the account card shows it. Null `signOut` means the sample demo. */
function useAccount() {
  const live = useProfile();
  if (!live) return { name: PEOPLE.me?.name ?? SAMPLE.name, email: PEOPLE.me?.email ?? SAMPLE.email, where: SAMPLE.workspace, signOut: null };
  const { user, workspace } = live.profile;
  return { name: user.name || PEOPLE.me?.name || user.email, email: user.email, where: `${workspace.name} · ${titleCase(workspace.role)}`, signOut: live.signOut };
}

/** The card itself: who, where, and what to do from it. `onDone` closes whatever holds it. */
export function AccountCard({ onDone }: { onDone?: () => void }) {
  const { dispatch } = useStore();
  const me = useAccount();
  const [leaving, setLeaving] = useState(false);
  return (
    <div className="acct-card">
      <div className="acct-who">
        <Avatar id="me" size={36} />
        <span className="acct-text">
          <strong className="acct-name">{me.name}</strong>
          <span className="acct-email">{me.email}</span>
          <span className="acct-where">{me.where}</span>
        </span>
      </div>
      <div className="acct-actions">
        <button
          className="acct-item"
          onClick={() => {
            dispatch({ type: 'navigate', route: { view: 'rules', tab: 'triage' } });
            onDone?.();
          }}
        >
          <Settings size={16} /> Rules & settings
        </button>
        {me.signOut ? (
          <button
            className="acct-item"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              me.signOut!();
            }}
          >
            <LogOut size={16} /> {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        ) : (
          <p className="acct-note">This is the sample workspace, so there’s nothing to sign out of.</p>
        )}
      </div>
    </div>
  );
}

/** The icon in the bottom bar and the card it opens above it. */
export function AccountMenu() {
  const me = useAccount();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>('.acct-pop button')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="bar-account" ref={wrap}>
      <button
        ref={trigger}
        className="bar-account-btn"
        aria-label={`Account: ${me.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Signed in as ${me.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar id="me" size={30} />
      </button>
      {open && (
        <div className="acct-pop" role="dialog" aria-label="Account">
          <AccountCard onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** On a phone: the icon as the tab bar's first tab, and the card in a sheet above the bar. */
export function AccountTab() {
  const me = useAccount();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ptab ptab-me" aria-label={`Account: ${me.name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="ptab-icon">
          <Avatar id="me" size={24} />
        </span>
        <span className="ptab-label">Account</span>
      </button>
      {open && <AccountSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function AccountSheet({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('.acct-card button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="sheet-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Account" ref={box}>
        <header className="sheet-head">
          <strong>Account</strong>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="sheet-account">
          <AccountCard onDone={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
