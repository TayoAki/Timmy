/**
 * Projects › Detect projects, on a real workspace. Timmy scans the last 90 days of mail, meetings and Drive files,
 * groups them into the projects they seem to be about (server/src/projects/detect.ts) and shows them as a list and as a
 * map of who and what belongs together. The person keeps, renames, merges or drops each; what is kept becomes projects,
 * their threads go in them, and new mail from the same people follows. Nothing changes in the mailbox or in Drive.
 */
import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Building2, FileText, FolderKanban, Mail, Radar, Users } from 'lucide-react';
import { Modal } from '../components/kit';
import { useStore } from '../state/store';
import { api, type DetectedProject, type ProjectScan } from './api';

const KIND_LABEL: Record<DetectedProject['kind'], string> = { client: 'Client work', deal: 'Deal', hiring: 'Hiring', vendor: 'Supplier', internal: 'Internal', personal: 'Personal', other: 'Project' };

interface Choice {
  keep: boolean;
  name: string;
  into: string;
}

export default function DetectProjects({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore();
  const [scan, setScan] = useState<ProjectScan | null | undefined>(undefined);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The latest scan, and while one runs, its state every two seconds.
  useEffect(() => {
    let gone = false;
    let timer = 0;
    const look = () =>
      api
        .projectScan()
        .then((r) => {
          if (gone) return;
          setScan(r.scan);
          if (r.scan?.status === 'running') timer = window.setTimeout(look, 2000);
        })
        .catch((e: Error) => !gone && setError(e.message));
    void look();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [scan?.id, scan?.status === 'running']);

  // Everything found starts out kept, under the name Timmy gave it.
  useEffect(() => {
    if (scan?.status !== 'ready') return;
    setChoices(Object.fromEntries(scan.proposals.map((p) => [p.id, { keep: true, name: p.name, into: '' }])));
  }, [scan?.id, scan?.status]);

  const start = async () => {
    setError('');
    setBusy(true);
    try {
      setScan(await api.detectProjects());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const keep = async () => {
    if (!scan) return;
    setBusy(true);
    setError('');
    try {
      const sent = scan.proposals.map((p) => {
        const c = choices[p.id]!;
        return { id: p.id, keep: c.keep || !!c.into, ...(c.name.trim() && c.name.trim() !== p.name ? { name: c.name.trim() } : {}), ...(c.into ? { into: c.into } : {}) };
      });
      const r = await api.keepProjects(scan.id, sent);
      const threads = r.created.reduce((n, c) => n + c.threads, 0);
      dispatch({ type: 'toast', text: r.created.length ? `Created ${r.created.length === 1 ? r.created[0]!.name : `${r.created.length} projects`} and put ${threads} thread${threads === 1 ? '' : 's'} in ${r.created.length === 1 ? 'it' : 'them'}. New mail from the same people goes there too.` : 'Nothing was kept.' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const kept = scan?.status === 'ready' ? scan.proposals.filter((p) => choices[p.id]?.keep && !choices[p.id]?.into) : [];
  const ready = scan?.status === 'ready';

  return (
    <Modal
      open
      onClose={onClose}
      width={ready ? 1180 : 560}
      title={ready ? `Timmy found ${scan.proposals.length === 1 ? '1 project' : `${scan.proposals.length} projects`}` : 'Detect projects'}
      description={ready ? 'Keep, rename or merge what fits, and drop the rest. Nothing changes in your mailbox or Drive.' : undefined}
      footer={
        ready ? (
          <>
            <button className="btn btn-sm btn-ghost dp-again" disabled={busy} onClick={() => void start()}>
              Scan again
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" disabled={busy || !scan.proposals.length} onClick={() => void keep()}>
              <FolderKanban size={14} />
              {kept.length ? `Create ${kept.length === 1 ? '1 project' : `${kept.length} projects`}` : 'Keep none'}
            </button>
          </>
        ) : undefined
      }
    >
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      {scan === undefined ? (
        <p className="dp-note" role="status">
          One moment…
        </p>
      ) : scan?.status === 'running' ? (
        <div className="dp-running" role="status">
          <Radar size={22} className="dp-spin" aria-hidden />
          <div>
            <strong>Reading your mail, meetings and files…</strong>
            <span>Timmy groups them by who you work with and what about, then names each group. This takes about a minute.</span>
          </div>
        </div>
      ) : ready ? (
        scan.proposals.length ? (
          <div className="dp-review">
            <ul className="dp-list" aria-label="Projects found">
              {scan.proposals.map((p) => (
                <Found key={p.id} p={p} all={scan.proposals} choices={choices} choice={choices[p.id]} focused={focus === p.id} onFocus={() => setFocus(p.id)} onChange={(c) => setChoices((x) => ({ ...x, [p.id]: { ...x[p.id]!, ...c } }))} />
              ))}
            </ul>
            <div className="dp-map" aria-label="Map of who and what belongs together">
              <ReactFlowProvider>
                <ProjectMap proposals={scan.proposals} choices={choices} focus={focus} onFocus={setFocus} />
              </ReactFlowProvider>
              <MapLegend />
            </div>
          </div>
        ) : (
          <p className="dp-note">Timmy didn’t find anything that looks like a project yet: no company or person comes up in more than one thread. Try again once more mail has come in.</p>
        )
      ) : (
        <div className="dp-intro">
          <p>
            Timmy reads the last 90 days of your mail, meetings and Drive files and groups them into the projects they seem to be about: the clients, deals, hires and suppliers you work with, and what you and your colleagues are planning.
          </p>
          <ul>
            <li>You see what it found as a list and a map, and choose what to keep, rename or merge.</li>
            <li>What you keep becomes projects: their threads go in them, their files and meetings are linked, and new mail from the same people goes there too.</li>
            <li>Nothing changes in your mailbox or your Drive.</li>
          </ul>
          {scan?.status === 'failed' && <p className="live-error">{scan.error ?? 'The last scan didn’t finish.'}</p>}
          {scan?.status === 'applied' && <p className="dp-note">You last kept projects from a scan on {new Date(scan.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. A new scan finds what has come in since, and what you dropped.</p>}
          <div className="dp-intro-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
              <Radar size={15} />
              Scan my mail
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** One project found: keep it, rename it, merge it into another, or drop it. */
function Found({ p, all, choices, choice, focused, onFocus, onChange }: { p: DetectedProject; all: DetectedProject[]; choices: Record<string, Choice>; choice?: Choice; focused: boolean; onFocus: () => void; onChange: (c: Partial<Choice>) => void }) {
  if (!choice) return null;
  // Only into one that is kept, under the name it has now.
  const others = all.filter((o) => o.id !== p.id && choices[o.id]?.keep && !choices[o.id]?.into);
  return (
    <li className="dp-item" data-focused={focused ? 'true' : undefined} data-dropped={!choice.keep && !choice.into ? 'true' : undefined} onMouseEnter={onFocus} onFocus={onFocus}>
      <div className="dp-item-top">
        <input type="checkbox" checked={choice.keep && !choice.into} aria-label={`Keep ${choice.name}`} onChange={(e) => onChange({ keep: e.target.checked, into: '' })} />
        <input className="input dp-name" value={choice.name} aria-label="Project name" maxLength={60} disabled={!choice.keep || !!choice.into} onChange={(e) => onChange({ name: e.target.value })} />
        <span className="dp-kind">{KIND_LABEL[p.kind]}</span>
      </div>
      {p.summary && <p className="dp-summary">{p.summary}</p>}
      <p className="dp-counts">
        <span>
          <Mail size={12} aria-hidden /> {p.threads.length} thread{p.threads.length === 1 ? '' : 's'}
        </span>
        <span>
          <Users size={12} aria-hidden /> {p.people.slice(0, 3).map((x) => x.name).join(', ')}
          {p.people.length > 3 ? ` +${p.people.length - 3}` : ''}
        </span>
        {p.files.length > 0 && (
          <span>
            <FileText size={12} aria-hidden /> {p.files.length} file{p.files.length === 1 ? '' : 's'}
          </span>
        )}
      </p>
      <p className="dp-subjects">{p.subjects.slice(0, 3).join(' · ')}</p>
      {others.length > 0 && (
        <label className="dp-merge">
          <span>Merge into</span>
          <select className="input" value={choice.into} onChange={(e) => onChange({ into: e.target.value, keep: e.target.value ? true : choice.keep })}>
            <option value="">—</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {choices[o.id]?.name.trim() || o.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </li>
  );
}

/**
 * The map: each project in the middle of its company, its people and its files. Projects sit on a ring, and what
 * belongs to each sits around it, so groups that share people are easy to tell apart.
 */
function ProjectMap({ proposals, choices, focus, onFocus }: { proposals: DetectedProject[]; choices: Record<string, Choice>; focus: string | null; onFocus: (id: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const ring = Math.max(260, proposals.length * 70);
    const people = new Map<string, string>();
    proposals.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / Math.max(proposals.length, 1) - Math.PI / 2;
      const cx = Math.cos(angle) * ring;
      const cy = Math.sin(angle) * ring;
      const c = choices[p.id];
      const dropped = c && !c.keep && !c.into;
      const label = c?.into ? `${c.name} → ${choices[c.into]?.name ?? ''}` : c?.name ?? p.name;
      nodes.push({ id: p.id, position: { x: cx - 80, y: cy - 22 }, data: { label }, className: `dp-node dp-node-project${focus === p.id ? ' dp-node-focus' : ''}${dropped ? ' dp-node-dropped' : ''}`, draggable: true });
      const around: { id: string; label: string; kind: 'org' | 'person' | 'file' }[] = [];
      if (p.organization) around.push({ id: `org:${p.organization.domain}`, label: p.organization.name, kind: 'org' });
      for (const person of p.people.slice(0, 4)) around.push({ id: `person:${person.email}`, label: person.name, kind: 'person' });
      for (const f of p.files.slice(0, 2)) around.push({ id: `file:${f.itemId}`, label: f.name, kind: 'file' });
      if (p.files.length > 2) around.push({ id: `files:${p.id}`, label: `+${p.files.length - 2} files`, kind: 'file' });
      around.forEach((a, j) => {
        // Satellites spread on the outer side of their project.
        const spread = Math.PI * 0.9;
        const t = around.length === 1 ? 0 : -spread / 2 + (spread * j) / (around.length - 1);
        const r = 150;
        const x = cx + Math.cos(angle + t) * r;
        const y = cy + Math.sin(angle + t) * r;
        const existing = a.kind === 'person' ? people.get(a.id) : undefined;
        if (!existing && !nodes.some((n) => n.id === a.id)) {
          nodes.push({ id: a.id, position: { x: x - 55, y: y - 14 }, data: { label: a.label }, className: `dp-node dp-node-${a.kind}`, draggable: true });
          if (a.kind === 'person') people.set(a.id, a.id);
        }
        edges.push({ id: `${p.id}-${a.id}`, source: p.id, target: a.id, className: focus === p.id ? 'dp-edge-focus' : undefined });
      });
    });
    return { nodes, edges };
  }, [proposals, choices, focus]);

  return (
    <ReactFlow nodes={nodes} edges={edges} defaultEdgeOptions={{ type: 'straight' }} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.2} maxZoom={1.6} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }} onNodeMouseEnter={(_e, n) => proposals.some((p) => p.id === n.id) && onFocus(n.id)}>
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** The legend for the map's shapes, under it. */
function MapLegend() {
  return (
    <p className="dp-legend">
      <span>
        <FolderKanban size={12} /> Project
      </span>
      <span>
        <Building2 size={12} /> Company
      </span>
      <span>
        <Users size={12} /> Person
      </span>
      <span>
        <FileText size={12} /> File
      </span>
    </p>
  );
}
