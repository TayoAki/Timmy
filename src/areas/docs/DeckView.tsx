/*
 * Slides: a grid of slide thumbnails. Click a slide to edit it. Select slides
 * to make a shareable subset: the copy goes to [04] Quick Share, with a check
 * for confidential slides and speaker notes before anything leaves the deck.
 */
import { ArrowUpRight, Check, CheckCheck, Copy, Lock, Mail, MessageSquareText, MousePointerClick, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { DocIcon } from '../../components/DocBits';
import { Field, Modal, PeoplePicker, Segmented } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Deck, Slide, WFile } from '../../data/ws-types';
import { useStore, ws } from '../../state/store';
import { firstName, folderLabel, patch, put, signOff, uid } from '../../state/ws';
import { NewDeckDialog } from './NewFiles';
import { SlideThumb } from './SlideThumb';
import { editableFiles, openFile, ranges, shortPath } from './shared';

const LAYOUTS: { id: Slide['layout']; label: string }[] = [
  { id: 'title', label: 'Title' },
  { id: 'bullets', label: 'Bullets' },
  { id: 'chart', label: 'Chart' },
  { id: 'quote', label: 'Quote' },
];

/** "2026-Q4 QBR — Briefing slides" → "2026-Q4 QBR". */
const baseName = (name: string) => name.replace(/\s*\((draft|final)\)$/i, '').replace(/\s+[—–-]\s+(Briefing slides|Slides|Deck|Proposal)$/i, '');

export function DeckView({ file, deck }: { file: WFile; deck: Deck }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [newDeck, setNewDeck] = useState(false);
  const [made, setMade] = useState<{ id: string; name: string; count: number } | null>(null);

  const ordered = deck.slides.filter((s) => sel.includes(s.id)).map((s) => s.id);
  const confidential = deck.slides.filter((s) => s.confidential).length;
  const withNotes = deck.slides.filter((s) => s.notes).length;
  const sources = file.project ? (W.projects[file.project]?.sources ?? []) : [];
  const working = editableFiles(W).filter((f) => f.id !== file.id && f.kind !== 'slides' && !!file.project && (f.project === file.project || sources.includes(f.id)));

  const toggle = (i: number, shift: boolean) => {
    const id = deck.slides[i]!.id;
    if (shift && anchor !== null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      const range = deck.slides.slice(a, b + 1).map((s) => s.id);
      setSel((cur) => [...new Set([...cur, ...range])]);
    } else {
      setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    }
    setAnchor(i);
  };

  const exitSelect = () => {
    setSelecting(false);
    setSel([]);
    setAnchor(null);
  };

  const editSlide = editing ? deck.slides.find((s) => s.id === editing) : undefined;

  const saveSlides = (slides: Slide[], opts?: { toast?: string; undo?: boolean }) =>
    dispatch(ws([patch('decks', deck.id, { slides }), patch('files', file.id, { updated: NOW })], opts));

  const addSlide = () => {
    const id = uid('s');
    saveSlides([...deck.slides, { id, title: 'New slide', layout: 'bullets', bullets: [''] }]);
    setEditing(id);
  };

  return (
    <div className="deck-view">
      <div className="doc-toolbar">
        <div className="doc-toolbar-info">
          <span className="chip">{deck.slides.length} slides</span>
          {confidential > 0 && (
            <span className="chip deck-conf">
              <Lock size={12} aria-hidden />
              {confidential} confidential
            </span>
          )}
          {withNotes > 0 && (
            <span className="chip">
              <MessageSquareText size={12} aria-hidden />
              {withNotes} with speaker notes
            </span>
          )}
        </div>
        <div className="doc-toolbar-actions">
          {selecting ? (
            <>
              <span className="deck-sel-count" aria-live="polite">
                {ordered.length} selected
              </span>
              <button className="btn btn-sm btn-ghost" onClick={() => setSel(sel.length === deck.slides.length ? [] : deck.slides.map((s) => s.id))}>
                <CheckCheck size={14} aria-hidden />
                {sel.length === deck.slides.length ? 'Clear' : 'Select all'}
              </button>
              <button className="btn btn-sm" onClick={exitSelect}>
                Cancel
              </button>
              <button className="btn btn-sm btn-primary" disabled={!ordered.length} onClick={() => setCopyOpen(true)}>
                <Copy size={14} aria-hidden />
                Copy to Quick Share
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-sm" onClick={addSlide}>
                <Plus size={14} aria-hidden />
                Add slide
              </button>
              <button className="btn btn-sm" onClick={() => setNewDeck(true)}>
                <Plus size={14} aria-hidden />
                New deck from layout
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => setSelecting(true)}>
                <MousePointerClick size={14} aria-hidden />
                Select slides to share
              </button>
            </>
          )}
        </div>
      </div>

      {selecting && <p className="deck-hint muted">Click slides to pick them. Shift-click picks a range. The copy goes to [04] Quick Share; this deck stays as it is.</p>}

      {made && (
        <div className="deck-made" role="status">
          <Check size={16} aria-hidden />
          <span>
            Copied {made.count} {made.count === 1 ? 'slide' : 'slides'} to [04] Quick Share as <strong>{made.name}</strong>
          </span>
          <div className="deck-made-actions">
            <button className="btn btn-xs" onClick={() => openFile(dispatch, made.id)}>
              <ArrowUpRight size={13} aria-hidden />
              Open copy
            </button>
            <button
              className="btn btn-xs"
              onClick={() => dispatch({ type: 'compose', draft: { to: [], subject: made.name, body: `Hi,\n\nHere are the slides: “${made.name}”.\n\n${signOff('Thanks')}`, project: file.project } })}
            >
              <Mail size={13} aria-hidden />
              Email a link
            </button>
            <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setMade(null)}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <ol className={`deck-grid${selecting ? ' selecting' : ''}`}>
        {deck.slides.map((s, i) => {
          const on = sel.includes(s.id);
          return (
            <li key={s.id}>
              <button
                className={`deck-slide${on ? ' on' : ''}`}
                aria-pressed={selecting ? on : undefined}
                aria-label={`Slide ${i + 1}: ${s.title}${s.confidential ? ', confidential' : ''}${s.notes ? ', has speaker notes' : ''}${selecting ? '' : '. Edit slide'}`}
                onClick={(e) => (selecting ? toggle(i, e.shiftKey) : setEditing(s.id))}
              >
                <span className="deck-frame">
                  <SlideThumb slide={s} />
                  {selecting && <span className="deck-check">{on && <Check size={13} strokeWidth={3} />}</span>}
                </span>
                <span className="deck-cap">
                  <span className="deck-num">{i + 1}</span>
                  <span className="deck-title">{s.title}</span>
                  {s.confidential && (
                    <span className="chip deck-conf deck-conf-chip" title="Confidential">
                      <Lock size={11} aria-hidden />
                      <span className="deck-conf-label">Confidential</span>
                    </span>
                  )}
                  {s.notes && <MessageSquareText size={14} className="deck-notes-icon" aria-label="Has speaker notes" />}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Working files</h2>
          <span className="section-sub">Keep the detail here; the deck shows the headline</span>
        </div>
        {working.length ? (
          <div className="deck-working">
            {working.map((f) => (
              <button key={f.id} className="doc-file-chip" onClick={() => openFile(dispatch, f.id)}>
                <DocIcon kind={f.kind} size={18} />
                <span className="doc-file-text">
                  <span className="doc-file-name">{f.name}</span>
                  <span className="doc-file-sub">{shortPath(W, f.folder)}</span>
                </span>
                <ArrowUpRight size={15} aria-hidden className="doc-file-go" />
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">No working files share this deck’s project yet. Put the figures in a sheet in the same project folder.</p>
        )}
      </section>

      {editSlide && (
        <SlideDialog
          key={editSlide.id}
          slide={editSlide}
          n={deck.slides.indexOf(editSlide) + 1}
          onClose={() => setEditing(null)}
          onSave={(s) => saveSlides(deck.slides.map((x) => (x.id === s.id ? s : x)))}
          onDelete={() => {
            setEditing(null);
            saveSlides(
              deck.slides.filter((x) => x.id !== editSlide.id),
              { toast: `Slide “${editSlide.title}” deleted`, undo: true },
            );
          }}
        />
      )}

      {copyOpen && (
        <CopyDialog
          file={file}
          deck={deck}
          selected={ordered}
          onLeaveOut={(id) => setSel((cur) => cur.filter((x) => x !== id))}
          onClose={() => setCopyOpen(false)}
          onDone={(m) => {
            setCopyOpen(false);
            exitSelect();
            setMade(m);
          }}
        />
      )}

      <NewDeckDialog open={newDeck} onClose={() => setNewDeck(false)} initial={{ project: file.project }} />
    </div>
  );
}

/* ───────────── Edit one slide ───────────── */

function SlideDialog({ slide, n, onClose, onSave, onDelete }: { slide: Slide; n: number; onClose: () => void; onSave: (s: Slide) => void; onDelete: () => void }) {
  const [s, setS] = useState(slide);
  const set = (change: Partial<Slide>) => setS((cur) => ({ ...cur, ...change }));
  return (
    <Modal
      open
      onClose={onClose}
      title={`Slide ${n}`}
      width={620}
      footer={
        <>
          <button className="btn btn-ghost doc-foot-left" onClick={onDelete}>
            <Trash2 size={14} aria-hidden />
            Delete slide
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onSave({ ...s, title: s.title.trim() || 'Untitled slide', notes: s.notes?.trim() || undefined, bullets: s.bullets?.filter((b) => b.trim()) });
              onClose();
            }}
          >
            Save slide
          </button>
        </>
      }
    >
      <div className="deck-edit">
        <div className="deck-edit-preview">
          <SlideThumb slide={s} />
        </div>
        <div className="deck-edit-fields">
          <Field label="Title">
            <input className="input" value={s.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <div className="field">
            <span className="field-label">Layout</span>
            <Segmented label="Layout" value={s.layout} onChange={(layout) => set({ layout })} options={LAYOUTS} />
          </div>
        </div>
      </div>
      {s.layout === 'bullets' && (
        <Field label="Bullets" hint="One per line.">
          <textarea className="input textarea" rows={3} value={(s.bullets ?? []).join('\n')} onChange={(e) => set({ bullets: e.target.value.split('\n') })} />
        </Field>
      )}
      <Field label="Speaker notes" hint="Notes stay with the slide when it’s copied, unless you remove them.">
        <textarea className="input textarea" rows={3} value={s.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <div className="field inline">
        <span className="field-label">
          <Lock size={13} aria-hidden /> Confidential: keep this slide out of shared copies
        </span>
        <button className="switch" role="switch" aria-checked={!!s.confidential} aria-label="Confidential" onClick={() => set({ confidential: !s.confidential || undefined })} />
      </div>
    </Modal>
  );
}

/* ───────────── Copy to Quick Share ───────────── */

function CopyDialog({
  file,
  deck,
  selected,
  onLeaveOut,
  onClose,
  onDone,
}: {
  file: WFile;
  deck: Deck;
  selected: string[];
  onLeaveOut: (id: string) => void;
  onClose: () => void;
  onDone: (m: { id: string; name: string; count: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const [recipient, setRecipient] = useState<string[]>([]);
  const [stripNotes, setStripNotes] = useState(true);
  const [name, setName] = useState<string | null>(null);

  const slides = selected.map((id) => ({ s: deck.slides.find((x) => x.id === id)!, n: deck.slides.findIndex((x) => x.id === id) + 1 }));
  const conf = slides.filter((x) => x.s.confidential);
  const notes = slides.filter((x) => x.s.notes);
  const auto = `${baseName(file.name)} — Slides ${ranges(slides.map((x) => x.n))}${recipient[0] ? ` for ${firstName(recipient[0])}` : ''}`;
  const value = name ?? auto;
  const quickShare = state.ws.folders.f04;

  const copy = () => {
    if (!slides.length || !value.trim()) return;
    const id = uid('slides');
    const copyFile: WFile = { id, name: value.trim(), kind: 'slides', folder: 'f04', updated: NOW, owner: 'me', project: file.project };
    const copySlides: Slide[] = slides.map(({ s }) => ({ ...s, notes: stripNotes ? undefined : s.notes }));
    dispatch(
      ws([put('files', copyFile), put('decks', { id, slides: copySlides })], {
        toast: `Copied ${slides.length} ${slides.length === 1 ? 'slide' : 'slides'} to [04] Quick Share`,
        undo: true,
        log: `Copied slides ${ranges(slides.map((x) => x.n))} of “${file.name}” to [04] Quick Share`,
      }),
    );
    onDone({ id, name: copyFile.name, count: slides.length });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Copy slides to Quick Share"
      description={`A new deck in ${quickShare ? folderLabel(quickShare) : '[04] Quick Share'} with only these slides. “${file.name}” stays as it is.`}
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!slides.length || !value.trim()} onClick={copy}>
            <Copy size={14} aria-hidden />
            {`Copy ${slides.length} ${slides.length === 1 ? 'slide' : 'slides'}`}
          </button>
        </>
      }
    >
      <ol className="deck-copy-list">
        {slides.map(({ s, n }) => (
          <li key={s.id}>
            <span className="deck-copy-thumb">
              <SlideThumb slide={s} />
            </span>
            <span className="deck-copy-text">
              <strong>
                {n}. {s.title}
              </strong>
              <span className="chips">
                {s.confidential && (
                  <span className="chip deck-conf">
                    <Lock size={11} aria-hidden />
                    Confidential
                  </span>
                )}
                {s.notes && (
                  <span className="chip">
                    <MessageSquareText size={11} aria-hidden />
                    Speaker notes
                  </span>
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>

      {conf.length > 0 && (
        <div className="deck-warn" role="alert">
          <ShieldAlert size={16} aria-hidden />
          <div className="deck-warn-body">
            <strong>
              {conf.length === 1 ? 'One slide is' : `${conf.length} slides are`} marked confidential
            </strong>
            <span>Confidential slides shouldn’t leave the private deck. Leave them out, or copy only if you’re sure the recipient can see them.</span>
            <ul className="deck-warn-list">
              {conf.map(({ s, n }) => (
                <li key={s.id}>
                  <span>
                    Slide {n}: {s.title}
                  </span>
                  <button className="btn btn-xs" onClick={() => onLeaveOut(s.id)}>
                    Leave it out
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div className="deck-notes">
          <div className="field inline">
            <span className="field-label">Remove speaker notes from the copy</span>
            <button className="switch" role="switch" aria-checked={stripNotes} aria-label="Remove speaker notes from the copy" onClick={() => setStripNotes((v) => !v)} />
          </div>
          <ul className="deck-notes-list">
            {notes.map(({ s, n }) => (
              <li key={s.id} className={stripNotes ? 'struck' : undefined}>
                <MessageSquareText size={13} aria-hidden />
                <span>
                  <span className="muted">Slide {n}:</span> {s.notes}
                </span>
              </li>
            ))}
          </ul>
          <span className="field-hint">{stripNotes ? 'The copy won’t include these notes.' : 'The copy keeps these notes. Anyone with the link can read them.'}</span>
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <span className="field-label">For</span>
          <PeoplePicker
            single
            value={recipient}
            onChange={(ids) => {
              setRecipient(ids);
            }}
            placeholder="Who is it for?"
          />
        </div>
      </div>
      <Field label="Name of the copy" hint={name === null ? 'Follows the slides and recipient you pick. Edit it to set your own.' : undefined}>
        <input className="input" value={value} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      </Field>
    </Modal>
  );
}
