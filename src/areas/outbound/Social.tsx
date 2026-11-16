/*
 * Social (coming soon): connect your accounts, see what's working, see what's
 * trending in your market, and write and schedule posts with Timmy. This
 * preview runs on sample numbers; drafts and schedules are saved here and
 * publish once social accounts can connect.
 */
import { BarChart3, CalendarClock, Megaphone, PenLine, Sparkles, Trash2, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { polishPost } from '../../lib/polish';
import type { SocialPost } from '../../data/outbound-types';
import { NOW } from '../../data/mock';
import { fmtDay, fmtTime } from '../../lib/format';
import { useStore } from '../../state/store';
import { Frame } from '../../components/Frame';
import { EmptyState, Field, Modal, SideHead } from '../../components/kit';
import { tint } from '../../components/common';
import { RpSection } from '../files/pickers';
import '../../styles/outbound.css';

type Tab = 'overview' | 'create' | 'calendar' | 'trends';

export const NETWORKS: { id: string; name: string; mark: string; limit: number }[] = [
  { id: 'linkedin', name: 'LinkedIn', mark: 'in', limit: 3000 },
  { id: 'x', name: 'X', mark: 'X', limit: 280 },
  { id: 'instagram', name: 'Instagram', mark: 'IG', limit: 2200 },
  { id: 'facebook', name: 'Facebook', mark: 'f', limit: 5000 },
  { id: 'tiktok', name: 'TikTok', mark: 'TT', limit: 2200 },
  { id: 'threads', name: 'Threads', mark: '@', limit: 500 },
  { id: 'youtube', name: 'YouTube', mark: 'YT', limit: 5000 },
];
const net = (id: string) => NETWORKS.find((n) => n.id === id)!;

/** Sample numbers for the preview, clearly labeled as such on screen. */
const SAMPLE = [
  { id: 'linkedin', followers: 2840, impressions: 41200, engagement: 4.1 },
  { id: 'x', followers: 1210, impressions: 18900, engagement: 1.8 },
  { id: 'instagram', followers: 640, impressions: 7400, engagement: 3.2 },
];

const TRENDS = [
  { topic: 'Front-desk automation in healthcare', where: 'LinkedIn', change: 48, why: 'Clinic managers are posting about patient no-shows and intake backlogs ahead of January.' },
  { topic: 'Spreadsheet horror stories', where: 'X', change: 32, why: 'Ops leaders are sharing the worst spreadsheet that runs their business.' },
  { topic: 'AI scheduling assistants', where: 'LinkedIn', change: 27, why: 'Posts comparing AI schedulers for small teams are getting saved and shared.' },
  { topic: 'Staffing shortages in home health', where: 'LinkedIn', change: 19, why: 'Industry reports on caregiver turnover are driving comment threads.' },
  { topic: 'Year-end budget planning', where: 'X', change: 15, why: 'Finance and ops leads are planning 2027 tooling budgets now.' },
];

export function ComingSoon() {
  return (
    <div className="soon-banner" role="note">
      <Megaphone size={16} aria-hidden />
      <span>
        <strong>Coming soon.</strong> Connecting accounts and publishing aren’t available yet. This preview uses sample numbers; drafts and schedules you make are saved and publish once accounts can connect.
      </span>
    </div>
  );
}

export function SocialView() {
  const { state, dispatch } = useStore();
  const tab: Tab = state.route.view === 'social' ? state.route.tab : 'overview';
  const posts = Object.values(state.out.posts);
  return (
    <Frame
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'create', label: 'Create' },
        { id: 'calendar', label: 'Calendar', count: posts.filter((p) => p.status === 'scheduled').length || undefined },
        { id: 'trends', label: 'Trending' },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'social', tab: id as Tab } })}
      wide
      scrollKey={`social-${tab}`}
    >
      <div className="out-head">
        <div>
          <h1 className="page-title">
            Social <span className="soon-tag">Coming soon</span>
          </h1>
          <p className="page-sub">Post where your buyers are, see what works, and catch what’s trending in your market, with Timmy writing the first draft.</p>
        </div>
      </div>
      <ComingSoon />
      {tab === 'overview' && <Overview />}
      {tab === 'create' && <Composer />}
      {tab === 'calendar' && <Calendar />}
      {tab === 'trends' && <Trends />}
    </Frame>
  );
}

function Overview() {
  const { dispatch } = useStore();
  const max = Math.max(...SAMPLE.map((s) => s.impressions));
  return (
    <>
      <section className="section" aria-labelledby="acc-title">
        <div className="section-head">
          <h2 className="section-title" id="acc-title">
            Accounts
          </h2>
        </div>
        <ul className="soc-accounts">
          {NETWORKS.map((n) => (
            <li key={n.id} className="card soc-acct">
              <span className="soc-mark" aria-hidden>
                {n.mark}
              </span>
              <strong>{n.name}</strong>
              <button className="btn btn-sm" onClick={() => dispatch({ type: 'toast', text: `${n.name} connections are coming soon. Timmy will let you know when you can connect.` })}>
                Connect
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="section" aria-labelledby="an-title">
        <div className="section-head">
          <h2 className="section-title" id="an-title">
            Last 28 days <span className="sample-tag">Sample</span>
          </h2>
        </div>
        <dl className="stat-tiles four">
          <div className="stat-tile">
            <dt>Followers</dt>
            <dd>{SAMPLE.reduce((n, s) => n + s.followers, 0).toLocaleString()}</dd>
            <span className="stat-sub">+3.4% vs prior 28 days</span>
          </div>
          <div className="stat-tile">
            <dt>Impressions</dt>
            <dd>{SAMPLE.reduce((n, s) => n + s.impressions, 0).toLocaleString()}</dd>
            <span className="stat-sub">+12%</span>
          </div>
          <div className="stat-tile">
            <dt>Engagement</dt>
            <dd>3.1%</dd>
            <span className="stat-sub">likes, comments, shares</span>
          </div>
          <div className="stat-tile">
            <dt>Best time to post</dt>
            <dd>Tue 9 AM</dd>
            <span className="stat-sub">for your LinkedIn audience</span>
          </div>
        </dl>
        <h3 className="soc-sub">Impressions by account</h3>
        <ul className="fc-list" aria-label="Impressions by account, sample">
          {SAMPLE.map((s) => (
            <li key={s.id} className="fc-row" title={`${net(s.id).name}: ${s.impressions.toLocaleString()} impressions, ${s.engagement}% engagement`}>
              <span className="fc-day">{net(s.id).name}</span>
              <span className="fc-track">
                <span className="fc-bar" style={{ width: `${(s.impressions / max) * 100}%` }} />
              </span>
              <span className="fc-n">
                {s.impressions.toLocaleString()} · {s.engagement}%
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const IDEAS = (proof: string, hook: string) => [
  `3 signs your ops team has outgrown ${hook}:\n\n1. Two people keep two versions of the truth.\n2. Reporting takes a day every week.\n3. New hires learn the workarounds before the work.\n\nWhich one is you?`,
  `${proof}\n\nThe trick wasn’t a big rollout. They moved one workflow first and let the team feel the difference.\n\nWhat would you move first?`,
  `Unpopular opinion: ${hook} aren’t the problem. Running your whole operation on them is.\n\nWhere’s the line for your team?`,
];

function Composer({ post, onDone }: { post?: SocialPost; onDone?: () => void }) {
  const { state, dispatch } = useStore();
  const [nets, setNets] = useState<string[]>(post?.networks ?? ['linkedin']);
  const [text, setText] = useState(post?.text ?? '');
  const [n, setN] = useState(0);
  // Your words before Timmy polished them, so you can go back.
  const [before, setBefore] = useState<string | null>(null);
  const days = Array.from({ length: 14 }, (_, i) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + i + 1));
  const [day, setDay] = useState(post?.at ? new Date(post.at.getFullYear(), post.at.getMonth(), post.at.getDate()).toISOString() : days[1]!.toISOString());
  const [time, setTime] = useState(post?.at ? `${String(post.at.getHours()).padStart(2, '0')}:${String(post.at.getMinutes()).padStart(2, '0')}` : '09:00');
  const tight = Math.min(...nets.map((x) => net(x).limit));
  const over = nets.filter((x) => text.length > net(x).limit);
  const at = () => {
    const d = new Date(day);
    const [h, m] = time.split(':').map(Number);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h!, m!);
  };
  const save = (status: SocialPost['status']) => {
    dispatch({ type: 'out', op: { op: 'post', post: { id: post?.id ?? `post-${Date.now().toString(36)}`, networks: nets, text, status, at: status === 'scheduled' ? at() : undefined, created: post?.created ?? NOW } } });
    if (onDone) onDone();
    else setText('');
  };
  return (
    <section className={post ? '' : 'section'} aria-label="Write a post">
      <div className="card soc-compose">
        <div className="soc-nets" role="group" aria-label="Post to">
          {NETWORKS.map((x) => (
            <button key={x.id} className="soc-net" aria-pressed={nets.includes(x.id)} onClick={() => setNets(nets.includes(x.id) ? nets.filter((y) => y !== x.id) : [...nets, x.id])}>
              <span className="soc-mark sm" aria-hidden>
                {x.mark}
              </span>
              {x.name}
            </button>
          ))}
        </div>
        <textarea className="soc-text" rows={8} value={text} placeholder="What do you want to say?" aria-label="Post" onChange={(e) => setText(e.target.value)} />
        <div className="soc-count">
          <span className={over.length ? 'warn' : 'muted'}>
            {text.length} / {Number.isFinite(tight) ? tight : '—'}
            {over.length ? ` · too long for ${over.map((x) => net(x).name).join(', ')}` : ''}
          </span>
          <span className="soc-assist">
            {before !== null && (
              <button className="link-btn" onClick={() => (setText(before), setBefore(null))}>
                Back to your version
              </button>
            )}
            <button
              className="btn btn-sm"
              title={text.trim() ? 'Tightens what you wrote and keeps your topic' : 'Suggests a post from your offer'}
              onClick={() => {
                if (text.trim()) {
                  // Your text is the post: Timmy tightens it, never swaps it for another.
                  setBefore(before ?? text);
                  setText(polishPost(text, Number.isFinite(tight) ? tight : Infinity));
                } else {
                  setText(IDEAS(state.out.offer.proof, state.out.offer.hook || 'spreadsheets')[n % 3]!);
                  setN(n + 1);
                }
              }}
            >
              <Sparkles size={14} /> {text.trim() ? 'Polish with Timmy' : 'Write with Timmy'}
            </button>
          </span>
        </div>
        <div className="soc-when">
          <Field label="Day">
            <select className="input sm" value={day} onChange={(e) => setDay(e.target.value)}>
              {days.map((d) => (
                <option key={d.toISOString()} value={d.toISOString()}>
                  {fmtDay(d)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Time">
            <select className="input sm" value={time} onChange={(e) => setTime(e.target.value)}>
              {['08:00', '09:00', '10:30', '12:00', '13:30', '15:00', '17:00', '19:00'].map((t) => (
                <option key={t} value={t}>
                  {fmtTime(new Date(2026, 0, 1, Number(t.slice(0, 2)), Number(t.slice(3))))}
                </option>
              ))}
            </select>
          </Field>
          <div className="soc-btns">
            <button className="btn btn-sm" disabled={!text.trim() || !nets.length} onClick={() => save('draft')}>
              Save draft
            </button>
            <button className="btn btn-sm btn-primary" disabled={!text.trim() || !nets.length || over.length > 0} onClick={() => save('scheduled')}>
              <CalendarClock size={14} /> Schedule
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Calendar() {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<SocialPost | null>(null);
  const posts = Object.values(state.out.posts).sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity) || b.created.getTime() - a.created.getTime());
  if (!posts.length) return <EmptyState icon={CalendarClock} title="Nothing scheduled" body="Write a post in Create and schedule it." />;
  return (
    <>
      <ul className="soc-posts">
        {posts.map((p) => (
          <li key={p.id} className="card soc-post">
            <header className="soc-post-head">
              <span className={`cstat ${p.status === 'scheduled' ? 'cs-active' : 'cs-draft'}`}>{p.status === 'scheduled' ? `Scheduled ${fmtDay(p.at!)}, ${fmtTime(p.at!)}` : 'Draft'}</span>
              <span className="soc-post-nets">
                {p.networks.map((x) => (
                  <span key={x} className="soc-mark sm" title={net(x).name}>
                    {net(x).mark}
                  </span>
                ))}
              </span>
              <button className="icon-btn sm" aria-label="Edit post" onClick={() => setEditing(p)}>
                <PenLine size={14} />
              </button>
              <button className="icon-btn sm" aria-label="Delete post" onClick={() => dispatch({ type: 'out', op: { op: 'removePost', id: p.id } })}>
                <Trash2 size={14} />
              </button>
            </header>
            <p className="soc-post-text">{p.text}</p>
          </li>
        ))}
      </ul>
      {editing && (
        <Modal open onClose={() => setEditing(null)} title="Edit post" width={640}>
          <Composer post={editing} onDone={() => setEditing(null)} />
        </Modal>
      )}
    </>
  );
}

function Trends() {
  const [draft, setDraft] = useState<SocialPost | null>(null);
  return (
    <section className="section" aria-labelledby="tr-title">
      <div className="section-head">
        <h2 className="section-title" id="tr-title">
          Trending in your market <span className="sample-tag">Sample</span>
        </h2>
      </div>
      <ul className="trend-list">
        {TRENDS.map((t) => (
          <li key={t.topic} className="card trend">
            <TrendingUp size={16} aria-hidden className="trend-icon" />
            <div className="trend-text">
              <strong>{t.topic}</strong>
              <span className="muted">
                {t.where} · +{t.change}% this week
              </span>
              <span className="trend-why">{t.why}</span>
            </div>
            <button className="btn btn-sm" onClick={() => setDraft({ id: `post-${Date.now().toString(36)}`, networks: [t.where === 'X' ? 'x' : 'linkedin'], text: `${t.topic}: here’s what we’re seeing with ${'teams like yours'}.\n\n`, status: 'draft', created: NOW })}>
              <PenLine size={14} /> Draft a post
            </button>
          </li>
        ))}
      </ul>
      {draft && (
        <Modal open onClose={() => setDraft(null)} title="Draft a post" width={640}>
          <Composer post={draft} onDone={() => setDraft(null)} />
        </Modal>
      )}
    </section>
  );
}

/* ───────────── Sidebar and right panel ───────────── */

export function SocialSide() {
  const { state, dispatch } = useStore();
  const tab = state.route.view === 'social' ? state.route.tab : null;
  const items: { id: Tab; label: string; icon: typeof BarChart3; hint: string; color: string }[] = [
    { id: 'overview', label: 'Overview', icon: BarChart3, hint: 'Accounts and analytics', color: 'var(--c-sky)' },
    { id: 'create', label: 'Create', icon: PenLine, hint: 'Write with Timmy', color: 'var(--c-violet)' },
    { id: 'calendar', label: 'Calendar', icon: CalendarClock, hint: 'Scheduled and drafts', color: 'var(--c-green)' },
    { id: 'trends', label: 'Trending', icon: TrendingUp, hint: 'What your market talks about', color: 'var(--c-amber)' },
  ];
  return (
    <>
      <SideHead
        icon={
          <span className="nav-icon" style={tint('var(--c-pink)')}>
            <Megaphone size={16} />
          </span>
        }
        title="Social"
        sub="Coming soon"
        action={
          <button className="btn" onClick={() => dispatch({ type: 'toast', text: 'You’re on the list. Timmy will let you know when social accounts can connect.' })}>
            Get early access
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          {items.map((x) => (
            <button key={x.id} className="nav-item" style={tint(x.color)} aria-current={tab === x.id ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'social', tab: x.id } })}>
              <span className="nav-icon">
                <x.icon size={16} />
              </span>
              <span className="nav-text">
                <span className="nav-name">{x.label}</span>
                <span className="nav-hint">{x.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export function SocialContext() {
  return (
    <>
      <RpSection title="What’s coming">
        <ul className="rp-rules">
          <li>Connect LinkedIn, X, Instagram, Facebook, TikTok, Threads and YouTube.</li>
          <li>One calendar for every post, with the best time for each audience.</li>
          <li>Analytics per post and per account, in plain words.</li>
          <li>What’s trending in your market each morning, in the daily brief.</li>
          <li>Comments and DMs in the unibox next to your email replies.</li>
        </ul>
      </RpSection>
      <RpSection title="Today">
        <p className="rp-text">Write and schedule posts now. They’re saved in this browser and go out once accounts can connect.</p>
      </RpSection>
    </>
  );
}
