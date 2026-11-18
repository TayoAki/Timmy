/**
 * Files › Drive & OneDrive, on a real workspace: the files Timmy keeps a list of from a connected Google Drive or
 * OneDrive (server/src/http/connected-files.ts). Each opens in its own app. Ask finds them by name, and by what they
 * say when their words are kept.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, FileText, Search, Sparkles } from 'lucide-react';
import { fmtShortWhen } from '../lib/format';
import { useStore } from '../state/store';
import { api } from './api';
import { FileViewer } from './FileViewer';

type Listed = Awaited<ReturnType<typeof api.connectedFiles>>;

export function ConnectedFiles() {
  const { dispatch } = useStore();
  const [q, setQ] = useState('');
  const [list, setList] = useState<Listed | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let gone = false;
    const timer = window.setTimeout(() => {
      api
        .connectedFiles(q.trim())
        .then((r) => {
          if (gone) return;
          setList(r);
          setError('');
        })
        .catch((e: Error) => !gone && setError(e.message));
    }, q ? 250 : 0);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  const apps = list?.apps ?? [];
  return (
    <>
      <h1 className="page-title">{apps.length ? apps.join(' and ') : 'Drive and OneDrive'}</h1>
      <p className="page-sub">
        The files Timmy keeps a list of: those changed in the last 90 days, and those most recently shared with you. Open one to read it here, or edit it in Timmy: Save goes back to the file in Google Drive, which keeps the earlier version. Ask can find one by name, or by what it says when its words are kept.
      </p>

      {list && !apps.length ? (
        <div className="card empty">
          <span className="empty-icon">
            <FileText size={20} />
          </span>
          <strong>No files connected</strong>
          <span>Connect Google Drive or OneDrive and Timmy lists your files here within a few minutes.</span>
          <button className="btn btn-sm btn-primary" onClick={() => dispatch({ type: 'navigate', route: { view: 'connections' } })}>
            Open Connections
          </button>
        </div>
      ) : (
        <>
          <label className="cf-search">
            <Search size={15} aria-hidden />
            <input className="input" type="search" placeholder="Find a file by name" aria-label="Find a file by name" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {error && <p className="live-error" role="alert">{error}</p>}
          {list && (
            <p className="cf-count" role="status">
              {list.total === 0
                ? q
                  ? 'No file names match.'
                  : 'No files yet. If you just connected, the list fills in within a few minutes.'
                : list.total > list.files.length
                  ? `The newest ${list.files.length} of ${list.total.toLocaleString('en-US')} files.`
                  : `${list.total.toLocaleString('en-US')} file${list.total === 1 ? '' : 's'}.`}
            </p>
          )}
          <ul className="card cf-list">
            {list?.files.map((f) => (
              <li key={f.id} className="cf-row">
                <FileText size={16} className="cf-icon" aria-hidden />
                <span className="cf-main">
                  {/* Opens inside Timmy; the arrow beside it opens the file in its own app. */}
                  <button type="button" className="cf-name" onClick={() => setOpen({ id: f.id, name: f.name })}>
                    {f.name}
                  </button>
                  <span className="cf-meta">
                    {f.kind} · {f.app}
                    {f.owner ? ` · ${f.owner}` : ''}
                  </span>
                </span>
                {f.readable && (
                  <span className="cf-readable" title="Timmy keeps its words, so Ask can find it by what it says">
                    <Sparkles size={12} aria-hidden /> Searchable
                  </span>
                )}
                <span className="cf-when">{fmtShortWhen(new Date(f.changed))}</span>
                {f.link && (
                  <a className="icon-btn sm cf-out" href={f.link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${f.name} in ${f.app}`} title={`Open in ${f.app}`}>
                    <ExternalLink size={14} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {open && <FileViewer itemId={open.id} name={open.name} onClose={() => setOpen(null)} />}
    </>
  );
}
