/*
 * A visitor on the website chat asked for a person. On a real workspace that shows in two places until a
 * teammate takes the chat over or answers it: a card at the top of "Needs you today" on Today, and a notice
 * across the app (in the corner where messages appear), so whoever is in Timmy sees it wherever they are.
 * There is no push to phones yet. Both read the chat's own flag, so they clear themselves.
 * What the visitor wrote is shown as text, cut short.
 */
import { MessagesSquare } from 'lucide-react';
import type { ChatConvo } from '../../data/ws-types';
import { fmtTime } from '../../lib/format';
import { wantsPerson } from '../../state/chat';
import { useStore } from '../../state/store';

const short = (text: string, most = 90) => (text.length > most ? `${text.slice(0, most)}…` : text);
/** What the visitor is called: their name or address as they typed it, cut short. */
const who = (c: ChatConvo) => short(c.name ?? c.email ?? 'A visitor', 40);

/** One card in Today's "Needs you today" list. */
export function ChatPersonRow({ c, n }: { c: ChatConvo; n: number }) {
  const { dispatch } = useStore();
  const said = [...c.messages].reverse().find((m) => m.from === 'visitor');
  const open = () => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'chat', id: c.id } });
  return (
    <li className="urg-row urg-lead urg-chat">
      <span className="urg-rank" aria-hidden>
        {n}
      </span>
      <span className="urg-chat-face" aria-hidden>
        <MessagesSquare size={16} />
      </span>
      <div className="urg-row-text">
        <button className="urg-row-title" onClick={open}>
          {who(c)} wants a person in your website chat
        </button>
        <span className="urg-row-sub">
          {said ? `“${short(said.text)}” · ${fmtTime(said.at)}` : 'Asked for a person'}
          {c.page ? ` · on ${c.page}` : ''}
        </span>
      </div>
      <div className="urg-row-side">
        <span className="urg urg-urgent">
          <span className="urg-dot" aria-hidden />
          Visitor waiting
        </span>
        <button className="btn btn-sm btn-primary" onClick={open}>
          Open the chat
        </button>
      </div>
    </li>
  );
}

/** The notice across the app. Not shown on the Website chat screen itself, where the chat is marked already. */
export function ChatNotice() {
  const { state, dispatch } = useStore();
  const waiting = wantsPerson(state);
  const r = state.route;
  if (!waiting.length || (r.view === 'outbound' && r.tab === 'chat')) return null;
  const first = waiting[0]!;
  return (
    <div className="toast chat-notice">
      <MessagesSquare size={15} aria-hidden />
      <span>{waiting.length === 1 ? `${who(first)} on your website chat is asking for a person.` : `${waiting.length} visitors on your website chat are asking for a person.`}</span>
      <button onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'chat', id: first.id } })}>Open the chat</button>
    </div>
  );
}
