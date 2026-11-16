/**
 * What a change to the workspace's own records must look like before it is saved.
 *
 * The screens change docs, pages, tasks, automations and chat settings with plain "put / patch / remove"
 * operations, and the reducer applies them as they come. That is fine in a browser that only holds its own
 * demo data. On a real workspace the same operations arrive from the network, other members read what is
 * saved, and it lands in the database, so the server decides what is acceptable:
 *   - only collections that exist, and records with sane ids;
 *   - docs made of known blocks, with links and pictures that can't carry a script;
 *   - automations whose graph is a graph (known blocks, no loops, one trigger);
 *   - chat settings within their limits, and visitors' conversations that only the server writes.
 */
import type { State } from '../../../src/state/store';
import type { AutoEdge, AutoNode, Automation, ChatWidget } from '../../../src/data/ws-types';
import { KIND } from '../../../src/areas/automations/catalog';
import { WS_COLLECTIONS } from '../../../src/live/patches';

const COLLECTIONS: ReadonlySet<string> = new Set(WS_COLLECTIONS);
const ID = /^[\w.:@-]{1,200}$/;
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;

/* ───────────── Docs ───────────── */

const BLOCK_TYPES = new Set(['h1', 'h2', 'h3', 'p', 'bullet', 'numbered', 'quote', 'todo', 'toggle', 'callout', 'code', 'divider', 'image', 'table', 'linked-table', 'file', 'page']);
const COLORS = /^(gray|brown|orange|yellow|green|blue|purple|pink|red)(-bg)?$/;
/** A picture is a web address, or a small image carried inline. SVG is left out: it can hold script. */
const PICTURE = /^(https:\/\/[^\s"'<>]{1,2000}|data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+)$/;
/** Inline pictures live in the workspace's stored state until uploads exist, so they are kept small. */
export const MAX_INLINE_PICTURE = 700_000;
const LINK = /^(https?:\/\/|mailto:)[^\s"'<>]{1,2000}$/i;
export const MAX_BLOCKS = 5000;

const picture = (v: unknown) => typeof v === 'string' && v.length <= MAX_INLINE_PICTURE && PICTURE.test(v);

function richProblem(rich: unknown): string | null {
  if (!Array.isArray(rich) || rich.length > 2000) return 'Its formatting isn’t in a form Timmy can save.';
  for (const n of rich) {
    if (!plain(n)) return 'Its formatting isn’t in a form Timmy can save.';
    if (n.type === 'hardBreak') continue;
    if (n.type !== 'text' || !text(n.text, 20_000)) return 'Its formatting isn’t in a form Timmy can save.';
    if (n.marks === undefined) continue;
    if (!Array.isArray(n.marks) || n.marks.length > 12) return 'Its formatting isn’t in a form Timmy can save.';
    for (const m of n.marks) {
      if (!plain(m) || !text(m.type, 40)) return 'Its formatting isn’t in a form Timmy can save.';
      if (m.attrs === undefined) continue;
      if (!plain(m.attrs)) return 'Its formatting isn’t in a form Timmy can save.';
      for (const [k, v] of Object.entries(m.attrs)) {
        if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return 'Its formatting isn’t in a form Timmy can save.';
        // A link is a web or mail address. Anything else in that place (javascript:, data:) is not a link.
        if (k === 'href' && v !== null && !(typeof v === 'string' && LINK.test(v))) return 'A link in it isn’t a web or email address.';
        if (typeof v === 'string' && v.length > 2100) return 'Its formatting isn’t in a form Timmy can save.';
      }
    }
  }
  return null;
}

function blocksProblem(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return 'That page’s contents aren’t in a form Timmy can save.';
  if (blocks.length > MAX_BLOCKS) return `A page can hold up to ${MAX_BLOCKS.toLocaleString('en-US')} blocks.`;
  const ids = new Set<string>();
  for (const b of blocks) {
    if (!plain(b) || typeof b.id !== 'string' || !ID.test(b.id) || !BLOCK_TYPES.has(String(b.type))) return 'That page has a block Timmy doesn’t know.';
    if (ids.has(b.id)) return 'Two blocks on that page have the same id.';
    ids.add(b.id);
    if (b.indent !== undefined && !(Number.isInteger(b.indent) && (b.indent as number) >= 0 && (b.indent as number) <= 8)) return 'A block on that page is nested too deep.';
    if (b.color !== undefined && !(typeof b.color === 'string' && COLORS.test(b.color))) return 'A block on that page has a colour Timmy doesn’t know.';
    if (b.text !== undefined && !text(b.text, 20_000)) return 'A block on that page is too long.';
    if (b.rich !== undefined) {
      const bad = richProblem(b.rich);
      if (bad) return bad;
    }
    if (b.type === 'image' && !(b.src === '' || picture(b.src))) return 'A picture on that page isn’t one Timmy can keep. Use a PNG, JPEG, GIF or WebP under 500 KB, or a web address that starts with https.';
    if (b.type === 'table') {
      const cols = b.columns;
      const rows = b.rows;
      if (!Array.isArray(cols) || cols.length > 40 || !cols.every((c) => text(c, 500))) return 'A table on that page isn’t in a form Timmy can save.';
      if (!Array.isArray(rows) || rows.length > 2000 || !rows.every((r) => Array.isArray(r) && r.length <= 40 && r.every((c) => text(c, 5000)))) return 'A table on that page isn’t in a form Timmy can save.';
    }
    if ((b.type === 'file' || b.type === 'page') && !(typeof b.file === 'string' && ID.test(b.file))) return 'A link to a page isn’t valid.';
    if (b.type === 'linked-table' && !(typeof b.sheet === 'string' && ID.test(b.sheet))) return 'A linked table isn’t valid.';
  }
  return null;
}

function docProblem(doc: Record<string, unknown>): string | null {
  if (doc.blocks !== undefined) {
    const bad = blocksProblem(doc.blocks);
    if (bad) return bad;
  }
  if (doc.icon !== undefined && !text(doc.icon, 16)) return 'That page’s icon isn’t valid.';
  if (doc.cover !== undefined && doc.cover !== null) {
    const c = doc.cover;
    if (!plain(c) || (c.kind !== 'gradient' && c.kind !== 'image')) return 'That page’s cover isn’t valid.';
    if (c.kind === 'gradient' && !(typeof c.value === 'string' && /^[\w-]{1,40}$/.test(c.value))) return 'That page’s cover isn’t valid.';
    if (c.kind === 'image' && !picture(c.value)) return 'That cover picture isn’t one Timmy can keep. Use a PNG, JPEG, GIF or WebP under 500 KB, or a web address that starts with https.';
    if (c.y !== undefined && !(typeof c.y === 'number' && c.y >= 0 && c.y <= 100)) return 'That page’s cover isn’t valid.';
  }
  return null;
}

/* ───────────── Automations ───────────── */

export const MAX_STEPS = 60;

/**
 * What is wrong with an automation's graph, in the words the person sees. `strict` is asked when it is
 * being switched on: a drawing in progress may be unfinished, but one that runs may not.
 */
export function automationProblems(a: Pick<Automation, 'nodes' | 'edges'>, strict: boolean): string[] {
  const out: string[] = [];
  const nodes = a.nodes as unknown;
  const edges = a.edges as unknown;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return ['The automation isn’t in a form Timmy can save.'];
  if (nodes.length > MAX_STEPS) return [`An automation can have up to ${MAX_STEPS} steps.`];
  if (edges.length > MAX_STEPS * 3) return ['That automation has too many connections.'];
  const byId = new Map<string, AutoNode>();
  for (const n of nodes) {
    if (!plain(n) || typeof n.id !== 'string' || !ID.test(n.id) || typeof n.kind !== 'string' || !Object.hasOwn(KIND, n.kind)) return ['The automation has a step Timmy doesn’t know.'];
    if (typeof n.x !== 'number' || typeof n.y !== 'number' || !Number.isFinite(n.x) || !Number.isFinite(n.y)) return ['A step’s place on the canvas isn’t valid.'];
    if (!plain(n.config) || Object.keys(n.config).length > 30 || !Object.entries(n.config).every(([k, v]) => k.length <= 60 && text(v, 4000))) return ['A step’s settings aren’t in a form Timmy can save.'];
    if (byId.has(n.id)) return ['Two steps have the same id.'];
    byId.set(n.id, n as unknown as AutoNode);
  }
  const next = new Map<string, string[]>();
  const seenEdge = new Set<string>();
  for (const e of edges) {
    if (!plain(e) || typeof e.id !== 'string' || !ID.test(e.id) || typeof e.from !== 'string' || typeof e.to !== 'string') return ['A connection isn’t valid.'];
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) return ['A connection points at a step that isn’t there.'];
    if (e.branch !== undefined && e.branch !== 'yes' && e.branch !== 'no') return ['A connection isn’t valid.'];
    if (seenEdge.has(e.id)) return ['Two connections have the same id.'];
    seenEdge.add(e.id);
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const triggers = [...byId.values()].filter((n) => KIND[n.kind]!.role === 'trigger');
  if (triggers.length > 1) out.push('An automation starts from one trigger. Remove the extra one.');
  // Nothing may lead into a trigger, and following the arrows must never come back round.
  if ((edges as AutoEdge[]).some((e) => KIND[byId.get(e.to)!.kind]!.role === 'trigger')) out.push('A trigger starts the automation; nothing can lead into it.');
  const state = new Map<string, 1 | 2>();
  const loops = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const to of next.get(id) ?? []) if (loops(to)) return true;
    state.set(id, 2);
    return false;
  };
  if ([...byId.keys()].some(loops)) out.push('The steps loop back on themselves. An automation runs from top to bottom once.');
  if (!strict || out.length) return out;

  if (triggers.length !== 1) return ['Add a trigger: what should start this automation?'];
  const reached = new Set<string>();
  const walk = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    for (const to of next.get(id) ?? []) walk(to);
  };
  walk(triggers[0]!.id);
  if (reached.size !== byId.size) out.push('Every step has to be connected to the trigger. Connect or remove the loose ones.');
  if (byId.size < 2) out.push('Add at least one step after the trigger.');
  const fields = new Set(Object.keys(KIND[triggers[0]!.kind]!.sample ?? {}));
  for (const n of byId.values()) {
    const k = KIND[n.kind]!;
    for (const f of k.fields) {
      if (f.type === 'select' && !n.config[f.id]) out.push(`“${k.label}” needs its “${f.label}” set.`);
      if (f.type === 'select' && n.config[f.id] && f.options && !f.options.includes(n.config[f.id]!)) out.push(`“${k.label}” has a “${f.label}” that isn’t one of the choices.`);
    }
    if (k.id === 'condition') {
      if (!n.config.value) out.push('“If / else” needs a value to compare with.');
      if (!(next.get(n.id) ?? []).length) out.push('“If / else” needs at least one branch connected.');
    }
    for (const v of Object.values(n.config)) for (const m of v.matchAll(/\{\{(\w+)\}\}/g)) if (!fields.has(m[1]!)) out.push(`“${k.label}” uses {{${m[1]}}}, which this trigger doesn’t provide.`);
  }
  return [...new Set(out)].slice(0, 6);
}

function automationProblem(a: Record<string, unknown>): string | null {
  if (!text(a.name, 200) || (a.description !== undefined && !text(a.description, 2000))) return 'That automation’s name or description is too long.';
  if (a.on !== undefined && typeof a.on !== 'boolean') return 'The automation isn’t in a form Timmy can save.';
  const problems = automationProblems(a as unknown as Automation, a.on === true);
  return problems.length ? problems.join(' ') : null;
}

/* ───────────── Website chat ───────────── */

/** How long visitors' conversations may be kept, in months. */
export const CHAT_RETENTION_MONTHS = [1, 3, 6, 12, 24];

function chatProblem(w: Record<string, unknown>): string | null {
  const c = w as Partial<ChatWidget> & Record<string, unknown>;
  if (c.id !== 'site') return 'A workspace has one website chat.';
  if (typeof c.on !== 'boolean' || typeof c.booking !== 'boolean') return 'Those chat settings aren’t in a form Timmy can save.';
  if (!(typeof c.domain === 'string' && (c.domain === '' || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(c.domain)) && c.domain.length <= 253)) return 'Enter the website as a plain address, like example.com.';
  if (!text(c.name, 80) || !text(c.greeting, 600)) return 'The chat’s name or greeting is too long.';
  if (!(typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color))) return 'Pick the chat’s colour from the palette.';
  if (c.icon !== undefined && c.icon !== '' && !(typeof c.icon === 'string' && c.icon.length <= 300_000 && /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(c.icon))) return 'The chat’s picture has to be a PNG, JPEG, GIF or WebP under 200 KB.';
  if (c.handoff !== 'notify' && c.handoff !== 'book' && c.handoff !== 'email') return 'Those chat settings aren’t in a form Timmy can save.';
  if (!Array.isArray(c.questions) || c.questions.length > 10 || !c.questions.every((q) => plain(q) && typeof q.id === 'string' && ID.test(q.id) && text(q.text, 300))) return 'The chat can ask up to 10 questions, each up to 300 characters.';
  if (!Array.isArray(c.faq) || c.faq.length > 60 || !c.faq.every((f) => plain(f) && typeof f.id === 'string' && ID.test(f.id) && text(f.q, 300) && text(f.a, 2000))) return 'The chat can hold up to 60 answers, each up to 2,000 characters.';
  // The link is shown to every visitor, so it is a plain https address and nothing else.
  if (c.privacyUrl !== undefined && c.privacyUrl !== '' && !(typeof c.privacyUrl === 'string' && /^https:\/\/[^\s"'<>\\]{1,500}$/.test(c.privacyUrl))) return 'The privacy policy link has to be a web address that starts with https://.';
  if (c.retentionMonths !== undefined && !CHAT_RETENTION_MONTHS.includes(c.retentionMonths as number)) return 'Chats can be kept for 1, 3, 6, 12 or 24 months.';
  // Whether this is the right key is the chat's own check (the server makes it); here it only has to look like one.
  if (c.siteKey !== undefined && !(typeof c.siteKey === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(c.siteKey))) return 'The key in the code snippet is made by Timmy and can’t be changed.';
  return null;
}

/* ───────────── Every change ───────────── */

/** The settings on a visitor's conversation that a member may flip. Everything else in it is written by the server. */
const CHAT_FLAGS = new Set(['unread', 'starred']);

const CHECKS: Partial<Record<string, (item: Record<string, unknown>) => string | null>> = { docs: docProblem, automations: automationProblem, chat: chatProblem };

/**
 * Looks at a batch of workspace operations before the reducer applies them.
 * Returns why they are refused, in words for the person, or null when they are fine.
 */
export function checkWsOps(state: State, ops: unknown): string | null {
  const refused = 'That change isn’t in a form Timmy can save.';
  if (!Array.isArray(ops) || ops.length > 400) return refused;
  // Later operations in a batch see what earlier ones did.
  const staged = new Map<string, Record<string, unknown> | null>();
  // Only records that are really there count: an id such as "constructor" names something every object has.
  const stored = (col: string, id: string) => {
    const records = (state.ws as unknown as Record<string, Record<string, unknown>>)[col];
    return records && Object.hasOwn(records, id) ? ((records[id] as Record<string, unknown> | undefined) ?? null) : null;
  };
  const current = (col: string, id: string) => (staged.has(`${col}/${id}`) ? staged.get(`${col}/${id}`)! : stored(col, id));
  for (const o of ops) {
    if (!plain(o) || typeof o.col !== 'string' || !COLLECTIONS.has(o.col)) return refused;
    const col = o.col;
    if (col === 'chats') {
      // A conversation belongs to the visitor who started it. A member can mark it read or star it here; what is
      // said in it, and who is answering, changes only through the chat's own commands.
      if (o.op !== 'patch' || !plain(o.patch) || !Object.keys(o.patch).every((k) => CHAT_FLAGS.has(k) && typeof (o.patch as Record<string, unknown>)[k] === 'boolean')) return 'A visitor’s conversation can’t be changed that way.';
    }
    let id: string;
    let item: Record<string, unknown> | null;
    if (o.op === 'put') {
      if (!plain(o.item) || typeof o.item.id !== 'string') return refused;
      id = o.item.id;
      item = o.item;
    } else if (o.op === 'patch') {
      if (typeof o.id !== 'string' || !plain(o.patch)) return refused;
      id = o.id;
      const before = current(col, id);
      // A patch to something that isn't there changes nothing; the reducer skips it too.
      if (!before) continue;
      if ('id' in o.patch && o.patch.id !== id) return refused;
      item = { ...before, ...o.patch };
    } else if (o.op === 'remove') {
      if (typeof o.id !== 'string') return refused;
      id = o.id;
      item = null;
    } else return refused;
    if (!ID.test(id)) return refused;

    if (col === 'chat' && o.op === 'remove') return 'The website chat’s settings can be changed, not removed.';
    if (item) {
      const bad = CHECKS[col]?.(item) ?? null;
      if (bad) return bad;
      if ('name' in item && item.name !== undefined && !text(item.name, 300)) return 'That name is too long.';
    }
    staged.set(`${col}/${id}`, item);
  }
  return null;
}
