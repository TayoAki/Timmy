/*
 * The automation editor: a canvas of blocks you drag in and wire together
 * (zoom, fit, lock, mini map), and a side panel with the blocks and the
 * selected step's settings. "Test run" walks the flow with sample data and
 * shows what each step would do; nothing is sent.
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, CheckCircle2, Circle, Copy, FlaskConical, Play, Save, Search, Trash2, X, Zap } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as RPointerEvent } from 'react';
import { Frame } from '../../components/Frame';
import { NOW } from '../../data/mock';
import type { AutoEdge, AutoNode, Automation } from '../../data/ws-types';
import { fmtStamp } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { patch, uid } from '../../state/ws';
import { KIND, KINDS, ROLE_LABEL, evaluate, fill, ready, type Kind } from './catalog';

type StepState = 'running' | 'done' | 'skipped';
type FlowNode = Node<{ n: AutoNode; index: number }, 'step'>;

/** Run state for the cards, without re-creating nodes on every tick. */
const RunCtx = createContext<Record<string, StepState>>({});

/* ───────────── Converting to React Flow and back ───────────── */

const toFlowNodes = (a: Automation): FlowNode[] => a.nodes.map((n, i) => ({ id: n.id, type: 'step', position: { x: n.x, y: n.y }, data: { n, index: i } }));
const toFlowEdges = (a: Automation): Edge[] =>
  a.edges.map((e) => ({ id: e.id, source: e.from, target: e.to, sourceHandle: e.branch ?? null, className: e.branch ? `ae-${e.branch}` : undefined }));

const fromFlow = (nodes: FlowNode[], edges: Edge[]): { nodes: AutoNode[]; edges: AutoEdge[] } => ({
  nodes: nodes.map((n) => ({ ...n.data.n, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
  edges: edges.map((e) => ({ id: e.id, from: e.source, to: e.target, ...(e.sourceHandle === 'yes' || e.sourceHandle === 'no' ? { branch: e.sourceHandle } : {}) })),
});

/* ───────────── A step on the canvas ───────────── */

function StepNode({ data, selected }: NodeProps<FlowNode>) {
  const run = useContext(RunCtx);
  const { n, index } = data;
  const k = KIND[n.kind];
  if (!k) return null;
  const ok = ready(n);
  const st = run[n.id];
  return (
    <div className={`ae-node${selected ? ' selected' : ''}${st ? ` ${st}` : ''}`} style={{ '--k': k.color } as CSSProperties}>
      {k.role !== 'trigger' && <Handle type="target" position={Position.Top} className="ae-handle" />}
      <span className={`ae-dot${ok ? ' ok' : ''}`} title={ok ? 'Ready' : 'Needs settings'} aria-hidden />
      <span className="ae-badge">{ROLE_LABEL[k.role]}</span>
      <div className="ae-node-head">
        <span className="ae-node-icon" aria-hidden>
          <k.icon size={17} />
        </span>
        <span className="ae-node-text">
          <span className="ae-node-title">{k.label}</span>
          <span className="ae-node-meta">
            Step {index + 1} · {k.app}
          </span>
        </span>
      </div>
      <p className="ae-node-sum">{k.summary(n.config)}</p>
      {st === 'done' && <CheckCircle2 size={16} className="ae-node-check" aria-label="Done in the test run" />}
      {k.id === 'condition' ? (
        <>
          <Handle type="source" position={Position.Bottom} id="yes" className="ae-handle yes" style={{ left: '30%' }} />
          <Handle type="source" position={Position.Bottom} id="no" className="ae-handle no" style={{ left: '70%' }} />
          <span className="ae-branch yes">Yes</span>
          <span className="ae-branch no">No</span>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="ae-handle" />
      )}
    </div>
  );
}

const NODE_TYPES = { step: StepNode };

/* ───────────── The editor ───────────── */

export function AutomationEditor() {
  const { state } = useStore();
  const id = state.route.view === 'automation' ? state.route.id : '';
  const a = state.ws.automations[id];
  return (
    <Frame tabs={[{ id: 'editor', label: 'Automation' }]} active="editor" onTab={() => undefined} wide bleed>
      {a ? (
        <ReactFlowProvider>
          <Canvas key={a.id} a={a} />
        </ReactFlowProvider>
      ) : (
        <p className="muted" style={{ padding: 32 }}>
          This automation isn’t here any more.
        </p>
      )}
    </Frame>
  );
}

function Canvas({ a }: { a: Automation }) {
  const { dispatch } = useStore();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(toFlowNodes(a));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(a));
  const [name, setName] = useState(a.name);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'blocks' | 'settings'>('blocks');
  const [locked, setLocked] = useState(false);
  const [run, setRun] = useState<Record<string, StepState>>({});
  const [log, setLog] = useState<{ id: string; text: string; skipped?: boolean }[] | null>(null);
  const [panelW, setPanelW] = useState(340);
  const [q, setQ] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const savedRef = useRef(JSON.stringify(fromFlow(toFlowNodes(a), toFlowEdges(a))));

  const current = fromFlow(nodes, edges);
  const dirty = JSON.stringify(current) !== savedRef.current || name.trim() !== a.name;
  const trigger = nodes.find((n) => KIND[n.data.n.kind]?.role === 'trigger');
  const canPublish = !!trigger && edges.some((e) => e.source === trigger.id);
  const sel = nodes.find((n) => n.id === selected);

  // Re-number steps when the list changes.
  useEffect(() => {
    setNodes((ns) => (ns.some((n, i) => n.data.index !== i) ? ns.map((n, i) => ({ ...n, data: { ...n.data, index: i } })) : ns));
  }, [nodes.length, setNodes]);

  const save = (extra: Partial<Automation> = {}, toast = 'Automation saved') => {
    const flow = fromFlow(nodes, edges);
    savedRef.current = JSON.stringify(flow);
    dispatch(ws([patch('automations', a.id, { ...flow, name: name.trim() || a.name, updated: NOW, ...extra })], { toast }));
  };

  const setOn = (on: boolean) => {
    if (on && !canPublish) return dispatch({ type: 'toast', text: 'Add a trigger and connect a step to it first.', tone: 'warn' });
    save({ on }, on ? 'Automation is on' : 'Automation is off');
  };

  /* ── adding and wiring steps ── */

  const addStep = (kind: Kind, at?: { x: number; y: number }) => {
    if (kind.role === 'trigger' && trigger) {
      dispatch({ type: 'toast', text: 'An automation has one trigger. Remove this one to use another.', tone: 'warn' });
      return;
    }
    const from = sel ?? [...nodes].sort((x, y) => y.position.y - x.position.y)[0];
    const position = at ?? (from ? { x: from.position.x, y: from.position.y + 150 } : { x: 120, y: 0 });
    const n: AutoNode = { id: uid('n'), kind: kind.id, x: position.x, y: position.y, config: {} };
    const node: FlowNode = { id: n.id, type: 'step', position, data: { n, index: nodes.length } };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...node, selected: true }]);
    // Clicked (not dropped): connect it under the selected or last step when that's free.
    if (!at && from && kind.role !== 'trigger' && KIND[from.data.n.kind]?.id !== 'condition' && !edges.some((e) => e.source === from.id)) {
      setEdges((es) => [...es, { id: uid('e'), source: from.id, target: n.id }]);
    }
    setSelected(n.id);
    setTab('settings');
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const k = KIND[e.dataTransfer.getData('application/x-timmy-step')];
    if (!k) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addStep(k, { x: p.x - 130, y: p.y - 30 });
  };

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (c.source === c.target) return false;
      if (edges.some((e) => e.target === c.target)) return false;
      return !edges.some((e) => e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null));
    },
    [edges],
  );

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge(
          { ...c, id: uid('e'), className: c.sourceHandle === 'yes' || c.sourceHandle === 'no' ? `ae-${c.sourceHandle}` : undefined },
          es,
        ),
      ),
    [setEdges],
  );

  const removeStep = (sid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== sid));
    setEdges((es) => es.filter((e) => e.source !== sid && e.target !== sid));
    setSelected(null);
    setTab('blocks');
  };

  const duplicateStep = (sid: string) => {
    const n = nodes.find((x) => x.id === sid);
    if (!n || KIND[n.data.n.kind]?.role === 'trigger') return;
    const copy: AutoNode = { ...n.data.n, id: uid('n'), config: { ...n.data.n.config }, x: n.position.x + 40, y: n.position.y + 40 };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { id: copy.id, type: 'step', position: { x: copy.x, y: copy.y }, data: { n: copy, index: ns.length }, selected: true }]);
    setSelected(copy.id);
  };

  const setConfig = (sid: string, key: string, value: string) =>
    setNodes((ns) => ns.map((n) => (n.id === sid ? { ...n, data: { ...n.data, n: { ...n.data.n, config: { ...n.data.n.config, [key]: value } } } } : n)));

  /* ── test run ── */

  const testRun = () => {
    if (!trigger) return dispatch({ type: 'toast', text: 'Add a trigger first.', tone: 'warn' });
    const data = { ...(KIND[trigger.data.n.kind]?.sample ?? {}) };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const order: { id: string; text: string }[] = [];
    const visited = new Set<string>();
    let cur: string | undefined = trigger.id;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const n = byId.get(cur);
      const k = n && KIND[n.data.n.kind];
      if (!n || !k) break;
      order.push({ id: n.id, text: k.test(n.data.n.config, data) });
      const branch = k.id === 'condition' ? (evaluate(n.data.n.config, data) ? 'yes' : 'no') : null;
      cur = edges.find((e) => e.source === n.id && (branch ? e.sourceHandle === branch : true))?.target;
    }
    const skipped = nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
    setLog([]);
    setRun({});
    order.forEach((step, i) => {
      window.setTimeout(() => {
        setRun((r) => ({ ...r, [step.id]: 'running' }));
      }, i * 650);
      window.setTimeout(() => {
        setRun((r) => ({ ...r, [step.id]: 'done' }));
        setLog((l) => [...(l ?? []), step]);
        if (i === order.length - 1) {
          setRun((r) => ({ ...r, ...Object.fromEntries(skipped.map((s) => [s, 'skipped' as const])) }));
          dispatch(ws([patch('automations', a.id, { tests: (a.tests ?? 0) + 1 })]));
        }
      }, i * 650 + 450);
    });
  };

  /* ── resizable side panel ── */

  const startResize = (e: RPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = panelW;
    const move = (ev: PointerEvent) => setPanelW(Math.max(280, Math.min(560, w0 - (ev.clientX - x0))));
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const palette = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = KINDS.filter((k) => (trigger ? k.role !== 'trigger' : true)).filter((k) => !s || `${k.label} ${k.app} ${k.description}`.toLowerCase().includes(s));
    return (['trigger', 'action', 'logic'] as const).map((role) => ({ role, items: list.filter((k) => k.role === role) })).filter((g) => g.items.length);
  }, [q, trigger]);

  const sampleKeys = trigger ? Object.keys(KIND[trigger.data.n.kind]?.sample ?? {}) : [];

  return (
    <RunCtx.Provider value={run}>
      <div className="ae">
        <div className="ae-top">
          <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'library', tab: 'automations' } })}>
            <ArrowLeft size={14} aria-hidden />
            Automations
          </button>
          <input className="ae-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Automation name" />
          <span className={`ae-saved${dirty ? ' dirty' : ''}`}>{dirty ? 'Unsaved changes' : `Saved ${fmtStamp(a.updated)}`}</span>
          <div className="ae-top-actions">
            <button className="btn btn-sm" onClick={testRun}>
              <FlaskConical size={14} aria-hidden />
              Test run
            </button>
            <button className={`btn btn-sm${dirty ? ' btn-primary' : ''}`} onClick={() => save()} disabled={!dirty}>
              <Save size={14} aria-hidden />
              Save
            </button>
            <label className={`ae-switch${a.on ? ' on' : ''}`} title={canPublish ? undefined : 'Add a trigger and connect a step to turn it on'}>
              <span>{a.on ? 'On' : 'Off'}</span>
              <button role="switch" aria-checked={a.on} aria-label="Automation on" onClick={() => setOn(!a.on)} className="ae-switch-track">
                <span className="ae-switch-thumb" />
              </button>
            </label>
          </div>
        </div>

        <div className="ae-body">
          <div className="ae-canvas" ref={wrap} onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))} onDrop={onDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={(_, n) => (setSelected(n.id), setTab('settings'))}
              onPaneClick={() => (setSelected(null), setTab('blocks'))}
              onNodesDelete={(ns) => ns.some((n) => n.id === selected) && setSelected(null)}
              nodesDraggable={!locked}
              nodesConnectable={!locked}
              elementsSelectable={!locked}
              deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              minZoom={0.3}
              maxZoom={1.6}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ type: 'smoothstep' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={14} size={1.2} />
              <Controls position="top-left" showInteractive onInteractiveChange={(on) => setLocked(!on)} />
              <MiniMap position="bottom-left" pannable zoomable style={{ width: 150, height: 100 }} nodeStrokeWidth={2} nodeColor={(n) => (KIND[(n as FlowNode).data.n.kind]?.color ?? 'var(--line-strong)')} maskColor="color-mix(in srgb, var(--bg) 65%, transparent)" />
            </ReactFlow>
            {nodes.length === 0 && (
              <div className="ae-empty">
                <Zap size={20} aria-hidden />
                <strong>Start with a trigger</strong>
                <span>Drag one in from the right, or click it.</span>
              </div>
            )}
            {log && (
              <div className="ae-log" role="log" aria-label="Test run">
                <div className="ae-log-head">
                  <FlaskConical size={14} aria-hidden />
                  <strong>Test run</strong>
                  <span className="muted">Sample data. Nothing is sent.</span>
                  <button className="icon-btn sm" aria-label="Close the test run" onClick={() => (setLog(null), setRun({}))}>
                    <X size={14} />
                  </button>
                </div>
                <ol className="ae-log-list">
                  {log.map((l, i) => {
                    const k = KIND[nodes.find((n) => n.id === l.id)?.data.n.kind ?? ''];
                    return (
                      <li key={l.id}>
                        <span className="ae-log-n">{i + 1}</span>
                        <span>
                          <strong>{k?.label}</strong> {l.text}
                        </span>
                      </li>
                    );
                  })}
                  {Object.values(run).includes('running') && (
                    <li className="ae-log-wait">
                      <Circle size={10} aria-hidden /> Running…
                    </li>
                  )}
                </ol>
              </div>
            )}
          </div>

          <div className="ae-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize the panel" />

          <aside className="ae-panel" style={{ width: panelW }}>
            <div className="ae-tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'blocks'} onClick={() => setTab('blocks')}>
                Blocks
              </button>
              <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')} disabled={!sel}>
                Settings
              </button>
            </div>

            {tab === 'blocks' && (
              <div className="ae-palette">
                <label className="ae-search">
                  <Search size={14} aria-hidden />
                  <input placeholder="Search blocks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search blocks" />
                </label>
                {!trigger && <p className="ae-hint">Every automation starts with one trigger.</p>}
                {palette.map((g) => (
                  <section key={g.role}>
                    <h4 className="ae-group">{g.role === 'trigger' ? 'Triggers' : g.role === 'action' ? 'Actions' : 'Logic'}</h4>
                    {g.items.map((k) => (
                      <button
                        key={k.id}
                        className="ae-card"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/x-timmy-step', k.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={() => addStep(k)}
                        style={{ '--k': k.color } as CSSProperties}
                        title="Drag onto the canvas, or click to add"
                      >
                        <span className="ae-node-icon" aria-hidden>
                          <k.icon size={16} />
                        </span>
                        <span className="ae-card-text">
                          <span className="ae-card-title">
                            {k.label}
                            <span className="ae-card-app">{k.app}</span>
                          </span>
                          <span className="ae-card-desc">{k.description}</span>
                        </span>
                      </button>
                    ))}
                  </section>
                ))}
              </div>
            )}

            {tab === 'settings' && sel && KIND[sel.data.n.kind] && (
              <StepSettings
                n={sel.data.n}
                k={KIND[sel.data.n.kind]!}
                chips={KIND[sel.data.n.kind]!.role === 'trigger' ? [] : sampleKeys}
                sample={trigger ? KIND[trigger.data.n.kind]?.sample ?? {} : {}}
                onChange={(key, v) => setConfig(sel.id, key, v)}
                onDelete={() => removeStep(sel.id)}
                onDuplicate={() => duplicateStep(sel.id)}
              />
            )}
          </aside>
        </div>
      </div>
    </RunCtx.Provider>
  );
}

function StepSettings({
  n,
  k,
  chips,
  sample,
  onChange,
  onDelete,
  onDuplicate,
}: {
  n: AutoNode;
  k: Kind;
  chips: string[];
  sample: Record<string, string>;
  onChange: (key: string, v: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { state } = useStore();
  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const conn = connectedFor(k.app, state.conn?.apps as Record<string, { connected?: boolean } | undefined> | undefined);
  const insert = (fid: string, key: string) => {
    const el = refs.current[fid];
    const cur = n.config[fid] ?? '';
    const at = el ? el.selectionStart : cur.length;
    const next = `${cur.slice(0, at)}{{${key}}}${cur.slice(at)}`;
    onChange(fid, next);
    requestAnimationFrame(() => {
      el?.focus();
      const p = at + key.length + 4;
      el?.setSelectionRange(p, p);
    });
  };
  const template = k.fields.find((f) => f.type === 'template');

  return (
    <div className="ae-settings">
      <header className="ae-set-head" style={{ '--k': k.color } as CSSProperties}>
        <span className="ae-node-icon" aria-hidden>
          <k.icon size={18} />
        </span>
        <span>
          <strong>{k.label}</strong>
          <span className="muted">{k.description}</span>
        </span>
      </header>

      <details className="ae-acc" open>
        <summary>Account</summary>
        <div className="ae-conn">
          <span className={`ae-conn-dot${conn !== false ? ' on' : ''}`} aria-hidden />
          <span>
            <strong>{k.app}</strong>
            <span className="muted">{conn === null ? 'Built into Timmy' : conn ? 'Connected' : 'Not connected yet. Connect it in Connections.'}</span>
          </span>
        </div>
      </details>

      <details className="ae-acc" open>
        <summary>{k.role === 'trigger' ? 'When' : k.role === 'logic' ? 'Rule' : 'Action'}</summary>
        {k.fields.map((f) => (
          <label key={f.id} className="field">
            <span className="field-label">{f.label}</span>
            {f.type === 'select' ? (
              <select className="input" value={n.config[f.id] ?? ''} onChange={(e) => onChange(f.id, e.target.value)}>
                <option value="">Choose…</option>
                {f.options!.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : f.type === 'template' ? (
              <textarea
                ref={(el) => {
                  refs.current[f.id] = el;
                }}
                className="input ae-template"
                rows={3}
                placeholder={f.placeholder}
                value={n.config[f.id] ?? ''}
                onChange={(e) => onChange(f.id, e.target.value)}
              />
            ) : (
              <input className="input" placeholder={f.placeholder} value={n.config[f.id] ?? ''} onChange={(e) => onChange(f.id, e.target.value)} />
            )}
          </label>
        ))}
        {template && chips.length > 0 && (
          <div className="ae-chips">
            <span className="ae-chips-label">From the trigger: click to insert</span>
            <div className="ae-chip-row">
              {chips.map((c) => (
                <button key={c} className="ae-chip" onClick={() => insert(template.id, c)} title={`Sample: ${sample[c]}`}>
                  {c}
                </button>
              ))}
            </div>
            {n.config[template.id] && (
              <p className="ae-preview">
                <span className="muted">Preview: </span>
                {fill(n.config[template.id]!, sample)}
              </p>
            )}
          </div>
        )}
      </details>

      <div className="ae-set-foot">
        {k.role !== 'trigger' && (
          <button className="btn btn-sm btn-ghost" onClick={onDuplicate}>
            <Copy size={14} aria-hidden />
            Duplicate
          </button>
        )}
        <button className="btn btn-sm btn-ghost danger" onClick={onDelete}>
          <Trash2 size={14} aria-hidden />
          Delete step
        </button>
      </div>
      <p className="ae-tip">
        <Play size={12} aria-hidden /> Use Test run to see what each step would do with sample data.
      </p>
    </div>
  );
}

/** Connection state for the block's app: null when it's part of Timmy. */
function connectedFor(app: string, apps?: Record<string, { connected?: boolean } | undefined>): boolean | null {
  const key = ({ Gmail: 'gmail', 'Google Drive': 'gdrive', Calendar: 'gcal', Slack: 'slack' } as Record<string, string>)[app];
  if (!key) return null;
  return !!apps?.[key]?.connected;
}
