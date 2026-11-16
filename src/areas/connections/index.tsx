/*
 * Connections: one button per app. In the product each button opens
 * Composio's connect page and Timmy pulls the data into your workspace; in
 * this preview, connecting is simulated and nothing leaves the browser.
 * Below the apps: who approves CRM writes, delegate mode, and enrichment.
 */
import { isLive } from '../../live/clock';
import { isConnectable } from '../../live/connectable';
import { Check, Clock, Plug, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { APPS, GROUPS, type AppDef } from '../../data/connections';
import { fmtDay } from '../../lib/format';
import { crmApp, enrichApp } from '../../state/connect';
import { useStore } from '../../state/store';
import { Frame } from '../../components/Frame';
import { Field, Modal } from '../../components/kit';
import { Meter } from '../outbound/shared';

export function ConnectionsView() {
  const { state } = useStore();
  const [connecting, setConnecting] = useState<AppDef | null>(null);
  const on = Object.values(state.conn.apps).filter((x) => x.connected).length;

  return (
    <Frame tabs={[{ id: 'apps', label: 'Connections' }]} active="apps" onTab={() => {}}>
      <h1 className="page-title">Connections</h1>
      <p className="page-sub">
        {on} apps connected. Each one connects through Composio: Timmy reads what you connect, and anything it writes waits for approval.{' '}
        {isLive() ? 'You sign in on Composio’s page; Timmy never sees your password. Gmail, Outlook, Google Calendar and Google Drive can be connected today; the others follow.' : 'In this preview, connecting is simulated and nothing leaves your browser.'}
      </p>

      {GROUPS.map((g) => (
        <section key={g} className="section" aria-labelledby={`cg-${g}`}>
          <div className="section-head">
            <h2 className="section-title" id={`cg-${g}`}>
              {g}
            </h2>
          </div>
          <ul className="conn-grid">
            {APPS.filter((a) => a.group === g).map((a) => (
              <AppCard key={a.id} app={a} onConnect={() => setConnecting(a)} />
            ))}
          </ul>
          {g === 'CRM' && <CrmPolicyPanel />}
          {g === 'Enrichment' && <EnrichPanel />}
        </section>
      ))}

      <DelegatePanel />

      {connecting && <ConnectDialog app={connecting} onClose={() => setConnecting(null)} />}
    </Frame>
  );
}

/** The card as a real workspace should read it: what Timmy does with the app today, not what the preview shows. */
const shown = (app: AppDef): AppDef => (isLive() && app.live ? { ...app, ...app.live } : app);

function AppCard({ app: def, onConnect }: { app: AppDef; onConnect: () => void }) {
  const app = shown(def);
  const { state, dispatch } = useStore();
  const c = state.conn.apps[app.id];
  // On a real workspace an app is offered only once Timmy can read it or act through it.
  const soon = app.soon || (isLive() && !isConnectable(app.id));
  return (
    <li className="card conn-card" data-connected={c?.connected ? 'true' : undefined}>
      <header className="conn-head">
        <span className="conn-mark" style={{ color: app.color }} aria-hidden>
          {app.mark}
        </span>
        <span className="conn-name">
          <strong>{app.name}</strong>
          <span className="conn-status">
            {soon ? (
              'Coming soon'
            ) : c?.connected ? (
              <>
                <Check size={12} aria-hidden /> Connected · {c.account}
              </>
            ) : c?.pendingAdmin ? (
              <>
                <Clock size={12} aria-hidden /> Waiting for your admin
              </>
            ) : (
              'Not connected'
            )}
          </span>
        </span>
      </header>
      <p className="conn-line">
        <span className="muted">Reads</span> {app.reads}
      </p>
      {app.writes && (
        <p className="conn-line">
          <span className="muted">Writes</span> {app.writes}
        </p>
      )}
      {app.credits !== undefined && (
        <p className="conn-line">
          <span className="muted">Cost</span> {app.credits} credit{app.credits === 1 ? '' : 's'} a lead
        </p>
      )}
      <footer className="conn-foot">
        {soon ? null : c?.connected ? (
          <>
            {c.at && <span className="muted">Since {fmtDay(c.at)}</span>}
            <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'conn', op: { op: 'disconnect', id: app.id } })}>
              Disconnect
            </button>
          </>
        ) : c?.pendingAdmin ? (
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'conn', op: { op: 'adminConsent', id: app.id } })} title="In the product this happens when your admin clicks the consent link">
            Admin approved (simulate)
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={onConnect}>
            <Plug size={14} /> Connect
          </button>
        )}
      </footer>
    </li>
  );
}

function ConnectDialog({ app: def, onClose }: { app: AppDef; onClose: () => void }) {
  const app = shown(def);
  const { dispatch } = useStore();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Connect ${app.name}`}
      description="You sign in to the app on a secure Composio page. Timmy never sees your password."
      width={500}
      footer={
        <>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-primary"
            data-autofocus
            onClick={() => {
              dispatch({ type: 'conn', op: { op: 'connect', id: app.id } });
              onClose();
            }}
          >
            <ShieldCheck size={14} /> Continue to {app.name}
          </button>
        </>
      }
    >
      <dl className="conn-dl">
        <dt>Timmy reads</dt>
        <dd>{app.reads}</dd>
        {app.writes && (
          <>
            <dt>Timmy may write</dt>
            <dd>{app.writes === 'Nothing' ? 'Nothing.' : `${app.writes}. Every write waits for approval.`}</dd>
          </>
        )}
      </dl>
      {app.note && <p className="conn-note">{app.note}</p>}
    </Modal>
  );
}

function CrmPolicyPanel() {
  const { state, dispatch } = useStore();
  const crm = state.conn.crm;
  const app = crmApp(state);
  const set = (patch: Partial<typeof crm>) => dispatch({ type: 'conn', op: { op: 'crm', patch } });
  return (
    <div className="card card-pad conn-policy" aria-label="CRM approvals">
      <strong>Who approves CRM changes</strong>
      <p className="field-hint">
        {app ? `Deal and stage changes wait for this person before Timmy writes them to ${app === 'hubspot' ? 'HubSpot' : app === 'salesforce' ? 'Salesforce' : 'Pipedrive'}.` : 'Applies once a CRM is connected. Until then, changes stay in Timmy.'}
      </p>
      <div className="seg-control" role="radiogroup" aria-label="CRM approver">
        <button role="radio" aria-checked={crm.approver === 'me'} onClick={() => set({ approver: 'me' })}>
          Me
        </button>
        <button role="radio" aria-checked={crm.approver === 'revops'} onClick={() => set({ approver: 'revops' })}>
          RevOps
        </button>
      </div>
      {crm.approver === 'revops' && (
        <Field label="RevOps approver">
          <input className="input" value={crm.revops} onChange={(e) => set({ revops: e.target.value })} />
        </Field>
      )}
      <label className="inline-check">
        <input type="checkbox" checked={crm.activity} onChange={(e) => set({ activity: e.target.checked })} /> Log calls and emails as CRM activity
      </label>
    </div>
  );
}

function EnrichPanel() {
  const { state, dispatch } = useStore();
  const e = state.conn.enrich;
  const app = enrichApp(state);
  const set = (patch: Partial<typeof e>) => dispatch({ type: 'conn', op: { op: 'enrichPolicy', patch } });
  return (
    <div className="card card-pad conn-policy" aria-label="Enrichment">
      <strong>Enrichment and leads Timmy finds</strong>
      <p className="field-hint">{app ? `Using ${app.name}. Enrichment only fills empty fields; it never overwrites what you have.` : 'Connect a provider to enrich leads and let Timmy add leads it finds.'}</p>
      <Meter used={e.monthly - e.credits} cap={e.monthly} label="Credits this month" unit="used" />
      <label className="inline-check">
        <input type="checkbox" checked={e.autoFind} onChange={(x) => set({ autoFind: x.target.checked })} /> Timmy may add and enrich leads it finds on its own. Contacting them still waits for you.
      </label>
      <Field label="Most leads Timmy adds in a day">
        <select className="input sm" value={e.perDay} onChange={(x) => set({ perDay: Number(x.target.value) })}>
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function DelegatePanel() {
  const { state, dispatch } = useStore();
  const d = state.conn.delegate;
  const set = (patch: Partial<typeof d>) => dispatch({ type: 'conn', op: { op: 'delegate', patch } });
  return (
    <section className="section" aria-labelledby="cg-delegate">
      <div className="section-head">
        <h2 className="section-title" id="cg-delegate">
          Delegate mode
        </h2>
        <span className="section-sub">For assistants and chiefs of staff working on someone else’s inbox</span>
      </div>
      <div className="card card-pad conn-policy">
        <label className="pref-row">
          <span>
            <strong>I work for someone else</strong>
            <span className="field-hint">You act on their mail and calendar. What needs their OK goes to them, and the log records who did what.</span>
          </span>
          <button className="switch" role="switch" aria-checked={d.on} aria-label="Delegate mode" onClick={() => set({ on: !d.on })} />
        </label>
        <div className="conn-two">
          <Field label="You">
            <input className="input" value={d.me} onChange={(e) => set({ me: e.target.value })} />
          </Field>
          <Field label="Working for">
            <input className="input" value={d.exec} onChange={(e) => set({ exec: e.target.value })} />
          </Field>
        </div>
        <label className="inline-check">
          <input type="checkbox" checked={d.external} onChange={(e) => set({ external: e.target.checked })} /> Emails to people outside the company wait for {d.exec.split(' ')[0]}
        </label>
        <label className="inline-check">
          <input type="checkbox" checked={d.decisions} onChange={(e) => set({ decisions: e.target.checked })} /> Decisions (price, hiring, deals) wait for {d.exec.split(' ')[0]}
        </label>
      </div>
    </section>
  );
}
