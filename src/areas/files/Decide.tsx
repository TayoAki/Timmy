import { CheckCheck, Copy, Eye, FolderSymlink, Inbox, Mail, Star, StarOff, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../../components/common';
import { DocIcon, DocPath } from '../../components/DocBits';
import { EmptyState, Field } from '../../components/kit';
import type { WFile } from '../../data/ws-types';
import { fmtStamp, plural } from '../../lib/format';
import { ws, useStore } from '../../state/store';
import { MAX_STARRED, patch, pathOf, personName, type WsOp } from '../../state/ws';
import { FileTable } from './Browse';
import { openFile, starAction } from './FileActions';
import { FILING_FOLDER, SHARED_FOLDER, copyOps, personLabel, projectFor, shortPath, shortcutOps, suggestShare, type ShareChoice } from './drive';
import { FolderSelect, NameHelper } from './pickers';

/* ───────────── To file ───────────── */

type Draft = { folder: string; name: string };

export function ToFile() {
  const { state, dispatch } = useStore();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const items = Object.values(state.ws.files)
    .filter((f) => f.folder === FILING_FOLDER && f.filing)
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());

  const valueOf = (f: WFile): Draft => drafts[f.id] ?? { folder: f.filing!.folder, name: f.filing!.name };
  const edited = items.some((f) => drafts[f.id]);
  const opsFor = (f: WFile): WsOp => {
    const v = valueOf(f);
    const project = projectFor(state.ws, v.folder);
    return patch('files', f.id, { folder: v.folder, name: v.name.trim() || f.filing!.name, filing: undefined, ...(project ? { project } : {}) });
  };
  const fileIt = (f: WFile) => {
    const v = valueOf(f);
    dispatch(ws([opsFor(f)], { toast: `Filed in ${shortPath(state.ws, v.folder)}`, undo: true, log: `Filed “${v.name.trim()}” in ${shortPath(state.ws, v.folder)}` }));
  };
  const fileAll = () =>
    dispatch(ws(items.map(opsFor), { toast: `Filed ${plural(items.length, 'attachment')}`, undo: true, log: `Filed ${plural(items.length, 'attachment')} from email` }));

  return (
    <>
      <div className="dr-page-head">
        <div>
          <h1 className="page-title">To file</h1>
          <p className="page-sub">Attachments Timmy saved from email. For each one, ask where you’ll use it, then file it there under a name you can search.</p>
        </div>
        {items.length > 1 && (
          <button className="btn btn-primary" onClick={fileAll}>
            <CheckCheck size={15} />
            {edited ? 'File all as shown' : 'File all as suggested'}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={CheckCheck}
          title="Everything is filed"
          body="New attachments wait here until you choose where they’ll be used."
          action={
            <button className="btn" onClick={() => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: 'f02' } })}>
              Open [02] Work
            </button>
          }
        />
      ) : (
        <div className="dr-cards">
          {items.map((f) => {
            const v = valueOf(f);
            const set = (change: Partial<Draft>) => setDrafts((d) => ({ ...d, [f.id]: { ...v, ...change } }));
            return (
              <article key={f.id} className="card dr-card" aria-label={f.name}>
                <header className="dr-card-head">
                  <DocIcon kind={f.kind} size={22} />
                  <div className="dr-card-title">
                    <h2 className="code">{f.name}</h2>
                    <p className="dr-card-meta">
                      <Avatar id={f.owner} size={18} />
                      <span>
                        From {personName(f.owner)} · {fmtStamp(f.updated)}
                      </span>
                    </p>
                  </div>
                  {f.filing?.fromThread && (
                    <button className="btn btn-sm" onClick={() => dispatch({ type: 'openThread', id: f.filing!.fromThread! })}>
                      <Mail size={14} />
                      Open email
                    </button>
                  )}
                </header>
                <div className="dr-card-body">
                  <Field
                    label="Where will you use this?"
                    hint={v.folder === f.filing!.folder ? 'Timmy’s suggestion, from the email and project it belongs to.' : `Timmy suggested ${shortPath(state.ws, f.filing!.folder)}.`}
                  >
                    <FolderSelect value={v.folder} onChange={(folder) => set({ folder })} label="Folder" suggested={f.filing!.folder} />
                  </Field>
                  <NameHelper value={v.name} onChange={(name) => set({ name })} fallbackDate={f.updated} label="Name it" />
                </div>
                <footer className="dr-card-foot">
                  <DocPath path={pathOf(state.ws, v.folder)} />
                  <button className="btn btn-primary" disabled={!v.name.trim()} onClick={() => fileIt(f)}>
                    File it
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ───────────── Shared with me ───────────── */

const CHOICES: { id: ShareChoice; title: string; line: string; icon: LucideIcon; action: string }[] = [
  { id: 'one-off', title: 'Leave it', line: 'A one-off: read it or answer it once. It stays in Shared with me.', icon: Eye, action: 'Leave it here' },
  { id: 'shortcut', title: 'Add a shortcut', line: 'A live file you’ll revisit. The shortcut always opens the latest version.', icon: FolderSymlink, action: 'Add shortcut' },
  { id: 'copy', title: 'Make a copy', line: 'A template, or a version you’ll change. The copy is yours to edit.', icon: Copy, action: 'Make a copy' },
];

export function Shared() {
  const { state, dispatch } = useStore();
  const shared = Object.values(state.ws.files).filter((f) => f.sharedBy && !f.shortcutOf);
  const pending = shared.filter((f) => f.share === 'pending').sort((a, b) => b.updated.getTime() - a.updated.getTime());
  const decided = shared.filter((f) => f.share && f.share !== 'pending');
  const people = [...new Set(decided.map((f) => f.sharedBy!))].sort((a, b) => personName(a).localeCompare(personName(b)));
  const [who, setWho] = useState<string>('');

  return (
    <>
      <h1 className="page-title">Shared with me</h1>
      <p className="page-sub">When someone shares a file, decide what it is to you. Most are one-offs; keep shortcuts for live files and copies for templates.</p>

      {pending.length === 0 ? (
        <EmptyState icon={Inbox} title="No shared files waiting" body="New shares land here until you decide what they are to you." />
      ) : (
        <div className="dr-cards">
          {pending.map((f) => (
            <ShareCard key={f.id} file={f} />
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <section className="section" aria-labelledby="dr-by-person">
          <div className="section-head">
            <h2 className="section-title" id="dr-by-person">
              Search by who shared it
            </h2>
            <span className="section-sub">Titles you can’t change are easy to find by the person</span>
          </div>
          <div className="filters dr-people" role="group" aria-label="Shared by">
            <button className="filter" aria-pressed={!who} onClick={() => setWho('')}>
              <Users size={14} />
              Everyone
            </button>
            {people.map((p) => (
              <button key={p} className="filter" aria-pressed={who === p} onClick={() => setWho(who === p ? '' : p)}>
                <Avatar id={p} size={18} />
                {personName(p)}
              </button>
            ))}
          </div>
          <ul className="dr-decided">
            {people
              .filter((p) => !who || p === who)
              .map((p) => (
                <li key={p} className="dr-decided-group">
                  <div className="dr-decided-person">
                    <Avatar id={p} size={24} />
                    <strong>{personName(p)}</strong>
                    <span className="muted">{plural(decided.filter((f) => f.sharedBy === p).length, 'file')}</span>
                  </div>
                  {decided
                    .filter((f) => f.sharedBy === p)
                    .map((f) => {
                      const sc = Object.values(state.ws.files).find((x) => x.shortcutOf === f.id);
                      const label =
                        f.share === 'one-off' ? 'Left as a one-off' : f.share === 'shortcut' ? (sc ? `Shortcut in ${shortPath(state.ws, sc.folder)}` : 'Shortcut removed') : 'Copied';
                      return (
                        <button key={f.id} className="dr-decided-row" onClick={() => dispatch(openFile(state.ws, f))}>
                          <DocIcon kind={f.kind} size={17} />
                          <span className="dr-row-name">{f.name}</span>
                          <span className={`chip${f.share === 'one-off' ? '' : ' accent'}`}>{label}</span>
                        </button>
                      );
                    })}
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ShareCard({ file: f }: { file: WFile }) {
  const { state, dispatch } = useStore();
  const sug = suggestShare(state.ws, f);
  const [choice, setChoice] = useState<ShareChoice>(sug.choice);
  const [folder, setFolder] = useState(sug.folder === SHARED_FOLDER ? 'f02' : sug.folder);
  const c = CHOICES.find((x) => x.id === choice)!;
  const groupLabel = `What is “${f.name}” to you?`;

  const decide = () => {
    const path = shortPath(state.ws, folder);
    const mark = patch('files', f.id, { share: choice });
    if (choice === 'one-off')
      return dispatch(ws([mark], { toast: `Left in Shared with me. Search “${personLabel(f.sharedBy!)}” to find it again.`, undo: true }));
    if (choice === 'shortcut') return dispatch(ws([...shortcutOps(state.ws, f, folder).ops, mark], { toast: `Shortcut added in ${path}`, undo: true }));
    dispatch(ws([...copyOps(state.ws, f, folder).ops, mark], { toast: `Copy saved in ${path}`, undo: true }));
  };

  return (
    <article className="card dr-card" aria-label={f.name}>
      <header className="dr-card-head">
        <DocIcon kind={f.kind} size={22} />
        <div className="dr-card-title">
          <h2>{f.name}</h2>
          <p className="dr-card-meta">
            <Avatar id={f.sharedBy!} size={18} />
            <span>
              Shared by {personName(f.sharedBy!)} · {fmtStamp(f.updated)}
            </span>
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => dispatch(openFile(state.ws, f))}>
          Open
        </button>
      </header>
      <div className="dr-choices" role="radiogroup" aria-label={groupLabel}>
        {CHOICES.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={choice === x.id} className="dr-choice" onClick={() => setChoice(x.id)}>
            <span className="dr-radio" aria-hidden />
            <x.icon size={17} className="dr-choice-icon" aria-hidden />
            <span className="dr-choice-text">
              <span className="dr-choice-title">
                {x.title}
                {x.id === sug.choice && <span className="chip accent dr-sug-chip">Timmy suggests</span>}
              </span>
              <span className="dr-choice-line">{x.line}</span>
            </span>
          </button>
        ))}
      </div>
      {choice !== 'one-off' && (
        <div className="dr-card-body">
          <Field label={choice === 'shortcut' ? 'Add the shortcut to' : 'Save the copy in'} hint={choice === sug.choice ? sug.why : undefined}>
            <FolderSelect value={folder} onChange={setFolder} label="Folder" suggested={sug.folder === SHARED_FOLDER ? undefined : sug.folder} />
          </Field>
        </div>
      )}
      <footer className="dr-card-foot">
        <span className="dr-foot-note">{choice === 'one-off' ? (choice === sug.choice ? sug.why : 'It stays in Shared with me.') : <DocPath path={pathOf(state.ws, folder)} />}</span>
        <button className="btn btn-primary" onClick={decide}>
          {c.action}
        </button>
      </footer>
    </article>
  );
}

/* ───────────── Starred ───────────── */

export function Starred() {
  const { state, dispatch } = useStore();
  const starred = Object.values(state.ws.files)
    .filter((f) => f.starred)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <h1 className="page-title">Starred</h1>
      <p className="page-sub">
        Five files at most: the ones you open every day. If everything is starred, nothing is. You have{' '}
        <strong className="mono">
          {starred.length} of {MAX_STARRED}
        </strong>{' '}
        starred.
      </p>
      <div className="dr-slots" aria-hidden>
        {Array.from({ length: MAX_STARRED }, (_, i) => (
          <span key={i} className={i < starred.length ? 'on' : ''} />
        ))}
      </div>
      {starred.length === 0 ? (
        <EmptyState icon={Star} title="Nothing starred" body="Star up to five files you open every day from any file’s menu." />
      ) : (
        <FileTable
          files={starred}
          showPath
          label="Starred files"
          extra={(f) => (
            <button
              className="btn btn-sm dr-unstar"
              onClick={(e) => {
                e.stopPropagation();
                dispatch(starAction(state.ws, f));
              }}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.stopPropagation()}
            >
              <StarOff size={14} />
              Unstar
            </button>
          )}
        />
      )}
    </>
  );
}
