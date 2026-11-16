/*
 * Blocks that aren't text: images, tables you type into, linked sheet tables,
 * file links and sub-pages. Each is one atom node drawn by React.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { ArrowUpRight, CalendarPlus, Columns3, ImagePlus, Link2, Plus, Trash2, X } from 'lucide-react';
import { createContext, useContext, useRef, useState, type CSSProperties } from 'react';
import { DocIcon } from '../../../components/DocBits';
import { NOW } from '../../../data/mock';
import { fmtDate } from '../../../lib/format';
import { useStore } from '../../../state/store';
import { BlockText } from '../BlockText';
import { LinkedTable } from '../LinkedTable';
import { openFile, shortPath } from '../shared';
import { LIVE } from '../../../live/config';

/* ───────────── What node views can ask the editor for ───────────── */

export interface DocCtx {
  readOnly: boolean;
  toast: (text: string) => void;
}
export const DocEditorContext = createContext<DocCtx>({ readOnly: false, toast: () => undefined });

const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
const stopEvent = ({ event }: { event: Event }) => isField(event.target) || (event.type === 'mousedown' && (event.target as HTMLElement)?.closest?.('button, a, input, textarea') != null);

const wrapStyle = (node: NodeViewProps['node']): CSSProperties => (node.attrs.indent ? ({ '--indent': node.attrs.indent } as CSSProperties) : {});

const jsonAttr = (name: string, fallback: unknown) => ({
  default: fallback,
  parseHTML: (el: HTMLElement) => {
    try {
      return JSON.parse(el.getAttribute(`data-${name}`) ?? '') ?? fallback;
    } catch {
      return fallback;
    }
  },
  renderHTML: (a: Record<string, unknown>) => ({ [`data-${name}`]: JSON.stringify(a[name]) }),
});

/* ───────────── Image ───────────── */

/** Downscale an uploaded picture so it fits in the browser's storage. */
async function shrink(file: File, max = LIVE ? 1000 : 1600): Promise<string> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return url;
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  // PNGs keep transparency in the demo; the live app sends JPEG to stay under the API's size cap.
  return c.toDataURL(file.type === 'image/png' && !LIVE ? 'image/png' : 'image/jpeg', LIVE ? 0.8 : 0.86);
}
export { shrink as shrinkImage };

function ImageView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const { readOnly } = useContext(DocEditorContext);
  const src = node.attrs.src as string;
  const width = node.attrs.width as number | null;
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const pick = async (f?: File | null) => {
    if (!f || !f.type.startsWith('image/')) return;
    setBusy(true);
    try {
      updateAttributes({ src: await shrink(f) });
    } finally {
      setBusy(false);
    }
  };

  const startResize = (e: PointerEvent, side: 1 | -1) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const start = e.clientX;
    const w0 = el.getBoundingClientRect().width;
    const maxW = el.parentElement?.getBoundingClientRect().width ?? 800;
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.max(120, Math.min(maxW, w0 + side * 2 * (ev.clientX - start))));
      el.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const w = Math.round(el.getBoundingClientRect().width);
      updateAttributes({ width: w >= maxW - 2 ? null : w });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!src) {
    return (
      <NodeViewWrapper className="nb nb-atom nb-image-empty" style={wrapStyle(node)} data-color={node.attrs.color ?? undefined}>
        <div className={`nb-image-add${selected ? ' selected' : ''}`} contentEditable={false}>
          <ImagePlus size={18} aria-hidden />
          <span className="nb-image-add-title">{busy ? 'Adding the image…' : 'Add an image'}</span>
          {!readOnly && (
            <div className="nb-image-add-row">
              <button className="btn btn-sm" onClick={() => input.current?.click()} disabled={busy}>
                Upload
              </button>
              <form
                className="nb-image-link"
                onSubmit={(e) => {
                  e.preventDefault();
                  const u = link.trim();
                  if (/^(https?:|data:image\/)/i.test(u)) updateAttributes({ src: u });
                }}
              >
                <input className="input input-sm" placeholder="Or paste an image link" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Image link" />
                <button className="btn btn-sm" type="submit" disabled={!link.trim()}>
                  Embed
                </button>
              </form>
              <button className="icon-btn sm" aria-label="Remove image block" onClick={() => deleteNode()}>
                <X size={14} />
              </button>
            </div>
          )}
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="nb nb-atom nb-image" style={wrapStyle(node)}>
      <figure className={`nb-figure${selected ? ' selected' : ''}`} contentEditable={false}>
        <div ref={box} className="nb-image-box" style={width ? { width } : undefined}>
          <img src={src} alt={node.attrs.caption || 'Image'} draggable={false} onDragStart={(e) => e.preventDefault()} />
          {!readOnly && editor.isEditable && (
            <>
              <span className="nb-resize l" onPointerDown={(e) => startResize(e.nativeEvent, -1)} aria-hidden />
              <span className="nb-resize r" onPointerDown={(e) => startResize(e.nativeEvent, 1)} aria-hidden />
              <div className="nb-image-tools">
                <button className="nb-tool" onClick={() => input.current?.click()} title="Replace">
                  <ImagePlus size={14} aria-hidden />
                  Replace
                </button>
                <button className="nb-tool" onClick={() => deleteNode()} title="Delete" aria-label="Delete image">
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            </>
          )}
        </div>
        {(node.attrs.caption || (!readOnly && editor.isEditable)) && (
          <input
            className="nb-caption"
            value={node.attrs.caption ?? ''}
            placeholder="Add a caption"
            aria-label="Caption"
            readOnly={readOnly}
            onChange={(e) => updateAttributes({ caption: e.target.value })}
          />
        )}
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </figure>
    </NodeViewWrapper>
  );
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: '', parseHTML: (el) => el.getAttribute('src') ?? el.querySelector('img')?.getAttribute('src') ?? '' },
      width: { default: null, parseHTML: (el) => Number(el.getAttribute('data-width')) || null, renderHTML: (a) => (a.width ? { 'data-width': a.width } : {}) },
      caption: { default: '', parseHTML: (el) => el.getAttribute('alt') ?? '', renderHTML: (a) => (a.caption ? { alt: a.caption } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: 'img[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, { stopEvent });
  },
});

/* ───────────── Table you type into ───────────── */

function TableView({ node, updateAttributes, selected }: NodeViewProps) {
  const { readOnly, toast } = useContext(DocEditorContext);
  const columns = node.attrs.columns as string[];
  const rows = node.attrs.rows as string[][];
  const dated = columns[0]?.trim().toLowerCase() === 'date';
  const wrap = useRef<HTMLDivElement>(null);
  const focusCell = (r: number | 'h', c: number) =>
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLTextAreaElement>(`[data-cell="${r}:${c}"]`)?.focus());

  const setCell = (i: number, j: number, v: string) => updateAttributes({ rows: rows.map((r, ri) => (ri === i ? r.map((c, ci) => (ci === j ? v : c)) : r)) });
  const addRow = () => {
    if (dated) {
      const today = fmtDate(NOW);
      const at = rows.findIndex((r) => r[0]?.trim() === today);
      if (at >= 0) {
        toast('Today’s row is already in the table');
        return focusCell(at, 1);
      }
      updateAttributes({ rows: [[today, ...columns.slice(1).map(() => '')], ...rows] });
      return focusCell(0, 1);
    }
    updateAttributes({ rows: [...rows, columns.map(() => '')] });
    focusCell(rows.length, 0);
  };
  const addColumn = () => {
    updateAttributes({ columns: [...columns, `Column ${columns.length + 1}`], rows: rows.map((r) => [...r, '']) });
    focusCell('h', columns.length);
  };
  const removeColumn = (j: number) => updateAttributes({ columns: columns.filter((_, k) => k !== j), rows: rows.map((r) => r.filter((_, k) => k !== j)) });

  return (
    <NodeViewWrapper className="nb nb-atom nb-table-block" style={wrapStyle(node)}>
      <div ref={wrap} className={`doc-table-block${selected ? ' selected' : ''}`} contentEditable={false}>
        <div className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                {columns.map((c, j) => (
                  <th key={j} className={/^date$/i.test(c.trim()) ? 'doc-col-date' : undefined}>
                    <div className="doc-th">
                      <BlockText
                        data-cell={`h:${j}`}
                        className="doc-cell doc-cell-head"
                        value={c}
                        readOnly={readOnly}
                        aria-label={`Column ${j + 1} name`}
                        onChange={(e) => updateAttributes({ columns: columns.map((x, k) => (k === j ? e.target.value : x)) })}
                      />
                      {columns.length > 1 && !readOnly && (
                        <button className="icon-btn sm doc-th-x" aria-label={`Remove column ${c || j + 1}`} onClick={() => removeColumn(j)}>
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                <th className="doc-row-tools" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {columns.map((_, j) => (
                    <td key={j}>
                      <BlockText
                        data-cell={`${i}:${j}`}
                        className="doc-cell"
                        value={r[j] ?? ''}
                        readOnly={readOnly}
                        aria-label={`${columns[j] || `Column ${j + 1}`}, row ${i + 1}`}
                        onChange={(e) => setCell(i, j, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className="doc-row-tools">
                    {!readOnly && (
                      <button className="icon-btn sm" aria-label={`Delete row ${i + 1}`} onClick={() => updateAttributes({ rows: rows.filter((_, k) => k !== i) })}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!readOnly && (
          <div className="doc-table-actions">
            <button className="btn btn-xs btn-ghost" onClick={addRow}>
              {dated ? <CalendarPlus size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
              {dated ? 'Add today’s row' : 'Add row'}
            </button>
            <button className="btn btn-xs btn-ghost" onClick={addColumn}>
              <Columns3 size={13} aria-hidden />
              Add column
            </button>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const TableNode = Node.create({
  name: 'table',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { columns: jsonAttr('columns', ['Column 1']), rows: jsonAttr('rows', [['']]) };
  },
  parseHTML() {
    return [
      { tag: 'table[data-columns]' },
      {
        // A table pasted from another app: first row is the header.
        tag: 'table',
        priority: 40,
        getAttrs: (el) => {
          const rows = [...(el as HTMLElement).querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => (td.textContent ?? '').trim()));
          if (!rows.length) return false;
          const width = Math.max(...rows.map((r) => r.length));
          const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
          return { columns: pad(rows[0]!), rows: rows.slice(1).map(pad) };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const cols = node.attrs.columns as string[];
    const rows = node.attrs.rows as string[][];
    return ['table', mergeAttributes(HTMLAttributes), ['tbody', ['tr', ...cols.map((c) => ['th', c])], ...rows.map((r) => ['tr', ...r.map((c) => ['td', c])])]];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableView, { stopEvent });
  },
});

/* ───────────── Linked sheet table ───────────── */

function LinkedTableView({ node, selected }: NodeViewProps) {
  const { state } = useStore();
  return (
    <NodeViewWrapper className="nb nb-atom nb-linked" style={wrapStyle(node)}>
      <div className={`nb-atom-box${selected ? ' selected' : ''}`} contentEditable={false}>
        <LinkedTable ws={state.ws} sheetId={node.attrs.sheet} columns={node.attrs.columns ?? undefined} />
      </div>
    </NodeViewWrapper>
  );
}

export const LinkedTableNode = Node.create({
  name: 'linkedTable',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { sheet: { default: '', parseHTML: (el) => el.getAttribute('data-sheet') ?? '', renderHTML: (a) => ({ 'data-sheet': a.sheet }) }, columns: jsonAttr('columns', null) };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="linkedTable"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'linkedTable' }), 'Linked table'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LinkedTableView, { stopEvent });
  },
});

/* ───────────── File link ───────────── */

function FileLinkView({ node, selected }: NodeViewProps) {
  const { state, dispatch } = useStore();
  const f = state.ws.files[node.attrs.file as string];
  return (
    <NodeViewWrapper className="nb nb-atom nb-file" style={wrapStyle(node)}>
      <div className={`nb-atom-box${selected ? ' selected' : ''}`} contentEditable={false}>
        {f ? (
          <button className="doc-file-chip" onClick={() => openFile(dispatch, f.id)}>
            <DocIcon kind={f.kind} size={18} />
            <span className="doc-file-text">
              <span className="doc-file-name">{f.name}</span>
              <span className="doc-file-sub">{shortPath(state.ws, f.folder)}</span>
            </span>
            <ArrowUpRight size={15} aria-hidden className="doc-file-go" />
          </button>
        ) : (
          <span className="chip">
            <Link2 size={12} aria-hidden />
            Linked file was removed
          </span>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const FileLinkNode = Node.create({
  name: 'fileLink',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { file: { default: '', parseHTML: (el) => el.getAttribute('data-file') ?? '', renderHTML: (a) => ({ 'data-file': a.file }) } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="fileLink"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'fileLink' }), 'Linked file'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileLinkView, { stopEvent });
  },
});

/* ───────────── Sub-page ───────────── */

function PageLinkView({ node, selected }: NodeViewProps) {
  const { state, dispatch } = useStore();
  const id = node.attrs.file as string;
  const f = state.ws.files[id];
  const body = state.ws.docs[id];
  return (
    <NodeViewWrapper className="nb nb-atom nb-page" style={wrapStyle(node)}>
      <div className={`nb-atom-box${selected ? ' selected' : ''}`} contentEditable={false}>
        <button className={`nb-page-link${f?.trashed ? ' trashed' : ''}`} onClick={() => f && openFile(dispatch, id)} disabled={!f}>
          <span className="nb-page-icon" aria-hidden>
            {body?.icon ?? '📄'}
          </span>
          <span className="nb-page-name">{f ? f.name || 'Untitled' : 'Deleted page'}</span>
          {f?.trashed && <span className="chip">In the trash</span>}
        </button>
      </div>
    </NodeViewWrapper>
  );
}

export const PageLinkNode = Node.create({
  name: 'pageLink',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { file: { default: '', parseHTML: (el) => el.getAttribute('data-file') ?? '', renderHTML: (a) => ({ 'data-file': a.file }) } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="pageLink"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'pageLink' }), 'Page'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView, { stopEvent });
  },
});
