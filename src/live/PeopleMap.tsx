/**
 * People › Map, on a real workspace: the people the person works with, the companies they are at, the projects Timmy
 * found and the person kept, the files and meetings that belong to them, and the promises still open, as a network.
 * Connected things are drawn near each other; bigger means more going on. Click anything to see what it is and what
 * it connects to; focus on it to see only that; filter by kind; search by name.
 * The data is what Timmy already keeps (server/src/ontology/map.ts); nothing new is read or stored.
 */
import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowRight, Building2, CalendarDays, FileText, FolderKanban, Handshake, Mail, Search, Users, X } from 'lucide-react';
import type { Thread } from '../data/types';
import { forceLayout } from '../lib/forceLayout';
import { byNewest, useStore } from '../state/store';
import { api, type MapNode, type MapNodeType, type WorkspaceMap } from './api';
import { FileViewer } from './FileViewer';

const KINDS: { type: MapNodeType; label: string; icon: typeof Users }[] = [
  { type: 'person', label: 'People', icon: Users },
  { type: 'company', label: 'Companies', icon: Building2 },
  { type: 'project', label: 'Projects', icon: FolderKanban },
  { type: 'file', label: 'Files', icon: FileText },
  { type: 'meeting', label: 'Meetings', icon: CalendarDays },
  { type: 'promise', label: 'Promises', icon: Handshake },
];
const GROUP: Record<MapNodeType, number> = { project: 0, company: 1, person: 2, file: 3, meeting: 4, promise: 5 };

/** A dot sized by how much is going on, its name under it; lines meet at its middle. */
function Dot({ data }: NodeProps) {
  const d = data as { label: string; kind: MapNodeType };
  const Icon = KINDS.find((k) => k.type === d.kind)!.icon;
  return (
    <div className="pm-dot-wrap">
      <Handle type="target" position={Position.Top} className="pm-handle" isConnectable={false} />
      <span className="pm-dot">
        <Icon size={13} aria-hidden />
      </span>
      <span className="pm-label">{d.label}</span>
      <Handle type="source" position={Position.Bottom} className="pm-handle" isConnectable={false} />
    </div>
  );
}
const NODE_TYPES = { dot: Dot };

export default function PeopleMap() {
  const [map, setMap] = useState<WorkspaceMap | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let gone = false;
    api
      .peopleMap()
      .then((m) => !gone && setMap(m))
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
  }, []);
  if (error)
    return (
      <p className="live-error" role="alert">
        {error}
      </p>
    );
  if (!map)
    return (
      <p className="pm-note" role="status">
        Drawing your map…
      </p>
    );
  if (!map.nodes.length)
    return (
      <div className="card empty">
        <span className="empty-icon">
          <Users size={20} />
        </span>
        <strong>Nothing to map yet</strong>
        <span>Connect your mail and Timmy maps the people you work with, their companies and your projects as mail comes in.</span>
      </div>
    );
  return (
    <ReactFlowProvider>
      <MapView map={map} />
    </ReactFlowProvider>
  );
}

function MapView({ map }: { map: WorkspaceMap }) {
  const { state, dispatch } = useStore();
  const flow = useReactFlow();
  const [shown, setShown] = useState<Set<MapNodeType>>(() => new Set(KINDS.map((k) => k.type)));
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);

  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map]);
  const neighbours = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const e of map.edges) {
      (out.get(e.source) ?? out.set(e.source, new Set()).get(e.source)!).add(e.target);
      (out.get(e.target) ?? out.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    return out;
  }, [map]);

  // What is drawn: the kinds switched on, and with a focus only what is within two steps of it.
  const visible = useMemo(() => {
    let ids = new Set(map.nodes.filter((n) => shown.has(n.type)).map((n) => n.id));
    if (focus && byId.has(focus)) {
      const near = new Set([focus]);
      for (const a of neighbours.get(focus) ?? []) {
        near.add(a);
        if (byId.get(a)?.type !== 'person' || byId.get(focus)?.type !== 'person') for (const b of neighbours.get(a) ?? []) near.add(b);
      }
      ids = new Set([...ids].filter((id) => near.has(id)));
      ids.add(focus);
    }
    return ids;
  }, [map, shown, focus, byId, neighbours]);

  const positions = useMemo(() => {
    const nodes = map.nodes.filter((n) => visible.has(n.id)).map((n) => ({ id: n.id, size: size(n), group: GROUP[n.type] }));
    const edges = map.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
    return forceLayout(nodes, edges);
  }, [map, visible]);

  const lit = useMemo(() => (selected ? new Set([selected, ...(neighbours.get(selected) ?? [])]) : null), [selected, neighbours]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? map.nodes.filter((n) => visible.has(n.id) && (n.label.toLowerCase().includes(q) || (n.sub ?? '').toLowerCase().includes(q))) : [];
  }, [query, map, visible]);

  const nodes: Node[] = useMemo(
    () =>
      map.nodes
        .filter((n) => visible.has(n.id))
        .map((n) => {
          const p = positions.get(n.id) ?? { x: 0, y: 0 };
          const s = size(n);
          const dim = lit ? !lit.has(n.id) : false;
          return {
            id: n.id,
            position: { x: p.x - s / 2, y: p.y - s / 2 },
            type: 'dot',
            data: { label: n.label, kind: n.type },
            className: `pm-node pm-${n.type}${selected === n.id ? ' pm-selected' : ''}${dim ? ' pm-dim' : ''}${matches.some((m) => m.id === n.id) ? ' pm-match' : ''}`,
            style: { width: s, height: s, ['--pm-size' as string]: `${s}px` },
            draggable: true,
          };
        }),
    [map, visible, positions, lit, selected, matches],
  );
  const edges: Edge[] = useMemo(
    () =>
      map.edges
        .filter((e) => visible.has(e.source) && visible.has(e.target))
        .map((e) => ({ id: `${e.source}~${e.target}~${e.kind}`, source: e.source, target: e.target, type: 'straight', className: `pm-edge pm-edge-${e.kind}${lit && !(lit.has(e.source) && lit.has(e.target) && (e.source === selected || e.target === selected)) ? ' pm-dim' : ''}` })),
    [map, visible, lit, selected],
  );

  const goTo = (id: string) => {
    setSelected(id);
    const p = positions.get(id);
    if (p) void flow.setCenter(p.x, p.y, { zoom: 1.1, duration: 400 });
  };

  const counts = KINDS.map((k) => ({ ...k, on: map.nodes.filter((n) => n.type === k.type).length }));
  const total = (t: MapNodeType) => ({ person: map.totals.people, company: map.totals.companies, project: map.totals.projects, file: map.totals.files, meeting: map.totals.meetings, promise: map.totals.promises })[t];
  const sel = selected ? byId.get(selected) : undefined;

  return (
    <div className="pm">
      <div className="pm-bar">
        <label className="pm-search">
          <Search size={14} aria-hidden />
          <input
            className="input"
            type="search"
            placeholder="Find a person, company or project"
            aria-label="Find on the map"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) goTo(matches[0].id);
            }}
          />
        </label>
        <div className="pm-kinds" role="group" aria-label="Show on the map">
          {counts
            .filter((k) => k.on > 0)
            .map((k) => (
              <button
                key={k.type}
                type="button"
                className={`pm-kind pm-kind-${k.type}`}
                aria-pressed={shown.has(k.type)}
                title={total(k.type) > k.on ? `${k.on} of ${total(k.type)} shown: the most active` : undefined}
                onClick={() => setShown((s) => (s.has(k.type) ? new Set([...s].filter((x) => x !== k.type)) : new Set([...s, k.type])))}
              >
                <k.icon size={13} aria-hidden />
                {k.label} <span className="pm-kind-count">{k.on}</span>
              </button>
            ))}
        </div>
        {focus && (
          <button type="button" className="btn btn-sm" onClick={() => setFocus(null)}>
            <X size={13} />
            Show everything
          </button>
        )}
      </div>
      <div className="pm-body">
        <div className="pm-canvas" aria-label="Map of the people, companies and projects you work with">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.1}
            maxZoom={2}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_e, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
          >
            <Background gap={28} size={1} />
            <Controls showInteractive={false} position="top-right" />
          </ReactFlow>
        </div>
        {sel && (
          <Details
            node={sel}
            near={[...(neighbours.get(sel.id) ?? [])].map((id) => byId.get(id)!).filter(Boolean)}
            threads={threadsOf(sel, state.threads)}
            onPick={goTo}
            onFocus={() => {
              setFocus(sel.id);
              void setTimeout(() => flow.fitView({ padding: 0.15, duration: 400 }), 30);
            }}
            focused={focus === sel.id}
            onClose={() => setSelected(null)}
            onOpenThread={(id) => dispatch({ type: 'openThread', id })}
            onOpenProject={(id) => dispatch({ type: 'navigate', route: { view: 'project', id, tab: 'overview' } })}
            onOpenFile={(id, name) => setViewing({ id, name })}
          />
        )}
      </div>
      {viewing && <FileViewer itemId={viewing.id} name={viewing.name} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** Size on the map, from how much is going on. */
function size(n: MapNode): number {
  const base = n.type === 'project' ? 54 : n.type === 'company' ? 40 : n.type === 'person' ? 26 : 18;
  return Math.round(base + Math.min(40, Math.sqrt(Math.max(0, n.weight)) * (n.type === 'project' ? 5 : 3)));
}

/** The threads behind a node, newest first: a person's, a company's people's, a project's. */
function threadsOf(n: MapNode, threads: Thread[]): Thread[] {
  let picked: Thread[] = [];
  if (n.type === 'person' && n.ref) picked = threads.filter((t) => t.participants.includes(`mail:${n.ref}`));
  else if (n.type === 'company' && n.ref) picked = threads.filter((t) => t.participants.some((p) => p.startsWith('mail:') && p.toLowerCase().endsWith(`@${n.ref}`)));
  else if (n.type === 'project' && n.ref) picked = threads.filter((t) => t.project === n.ref);
  else if (n.type === 'promise' && n.ref) picked = threads.filter((t) => t.id === n.ref);
  return [...picked].sort(byNewest).slice(0, 8);
}

function Details({
  node,
  near,
  threads,
  focused,
  onPick,
  onFocus,
  onClose,
  onOpenThread,
  onOpenProject,
  onOpenFile,
}: {
  node: MapNode;
  near: MapNode[];
  threads: Thread[];
  focused: boolean;
  onPick: (id: string) => void;
  onFocus: () => void;
  onClose: () => void;
  onOpenThread: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenFile: (id: string, name: string) => void;
}) {
  const kind = KINDS.find((k) => k.type === node.type)!;
  const groups = KINDS.map((k) => ({ ...k, items: near.filter((n) => n.type === k.type) })).filter((g) => g.items.length);
  return (
    <aside className="pm-details" aria-label={`About ${node.label}`}>
      <header className="pm-details-head">
        <span className={`pm-details-icon pm-${node.type}`} aria-hidden>
          <kind.icon size={16} />
        </span>
        <div>
          <h2>{node.label}</h2>
          {node.sub && <p>{node.type === 'promise' ? undefined : node.sub}</p>}
          {node.type === 'promise' && (
            <p>
              {node.who === 'me' ? 'You promised this' : 'Promised to you'}
              {node.due ? `, due ${new Date(`${node.due}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
            </p>
          )}
        </div>
        <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className="pm-details-actions">
        {!focused && (
          <button type="button" className="btn btn-sm" onClick={onFocus}>
            Show only what connects
          </button>
        )}
        {node.type === 'project' && node.ref && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpenProject(node.ref!)}>
            Open project
            <ArrowRight size={13} />
          </button>
        )}
        {node.type === 'file' && node.ref && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpenFile(node.ref!, node.label)}>
            Open file
          </button>
        )}
      </div>
      {threads.length > 0 && (
        <section>
          <h3>
            <Mail size={13} aria-hidden /> Latest threads
          </h3>
          <ul className="pm-list">
            {threads.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => onOpenThread(t.id)}>
                  {t.subject}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {groups.map((g) => (
        <section key={g.type}>
          <h3>
            <g.icon size={13} aria-hidden /> {g.label}
          </h3>
          <ul className="pm-list">
            {g.items.slice(0, 12).map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => onPick(n.id)}>
                  {n.label}
                  {n.type === 'person' && n.sub ? <span>{n.sub}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
