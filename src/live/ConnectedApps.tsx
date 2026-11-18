/**
 * Rules & settings › Approvals: using Timmy from another AI app over MCP (server/src/http/mcp.ts). The address to
 * paste into Claude, ChatGPT or Claude Code, and the apps connected to this workspace, each with Disconnect.
 */
import { Copy, Plug } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { useProfile } from './LiveApp';

interface ConsentRow {
  id: string;
  clientId: string;
  referenceId?: string | null;
  createdAt?: string;
}

export function ConnectedApps() {
  const { dispatch } = useStore();
  const live = useProfile();
  const url = `${window.location.origin}/mcp`;
  const [apps, setApps] = useState<(ConsentRow & { name: string })[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/oauth2/get-consents', { credentials: 'same-origin' });
      const rows = res.ok ? ((await res.json()) as ConsentRow[]) : [];
      // Only the apps connected to this workspace; another workspace's are listed there.
      const here = rows.filter((r) => r.referenceId === live?.profile.workspace.id);
      const named = await Promise.all(
        here.map(async (r) => {
          const c = await fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(r.clientId)}`, { credentials: 'same-origin' })
            .then((x) => (x.ok ? x.json() : null))
            .catch(() => null);
          return { ...r, name: ((c as { client_name?: string } | null)?.client_name ?? 'An app').slice(0, 80) };
        }),
      );
      setApps(named);
    } catch {
      setApps([]);
    }
  }, [live?.profile.workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async (row: ConsentRow & { name: string }) => {
    const res = await fetch('/api/auth/oauth2/delete-consent', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id }) });
    dispatch({ type: 'toast', text: res.ok ? `${row.name} is disconnected. It can’t use Timmy any more.` : 'That didn’t work. Try again.', ...(res.ok ? {} : { tone: 'warn' as const }) });
    void load();
  };

  return (
    <section className="field connect-apps" aria-label="Use Timmy from other AI apps">
      <span className="field-label">
        <Plug size={14} aria-hidden /> Use Timmy from Claude, ChatGPT or another AI app
      </span>
      <div className="connect-url">
        <input className="input" readOnly value={url} aria-label="Timmy’s MCP address" onFocus={(e) => e.currentTarget.select()} />
        <button
          className="btn btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(url).catch(() => {});
            dispatch({ type: 'toast', text: 'Copied. Paste it into your AI app.' });
          }}
        >
          <Copy size={14} aria-hidden /> Copy
        </button>
      </div>
      <ol className="connect-steps">
        <li>
          Claude: Settings › Connectors › Add custom connector, and paste the address.
        </li>
        <li>ChatGPT: Settings › Apps & Connectors › Create (developer mode), and paste the address.</li>
        <li>
          Claude Code: <code>claude mcp add --transport http timmy {url}</code>
        </li>
      </ol>
      <span className="field-hint">
        You sign in to Timmy and choose this workspace; the app then works as you, with your AI doing the thinking. It reads and keeps drafts, to-dos and projects; emails, filing and rules it prepares wait for your OK here.
      </span>
      {apps && apps.length > 0 && (
        <ul className="connect-app-list" aria-label="Connected apps">
          {apps.map((a) => (
            <li key={a.id}>
              <span>
                <strong>{a.name}</strong>
                {a.createdAt && <span className="muted"> · connected {new Date(a.createdAt).toLocaleDateString()}</span>}
              </span>
              <button className="btn btn-sm btn-ghost" onClick={() => void disconnect(a)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
