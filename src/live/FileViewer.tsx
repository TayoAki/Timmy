/**
 * A file from a connected Google Drive or OneDrive, shown inside Timmy (server/src/files/view.ts): a Google Doc with
 * its formatting in a frame that runs nothing, a sheet as a table, slides one after another, an Office file's words.
 * "Edit in Timmy" opens it in Timmy's own editor, where Save goes back to the Drive file (DriveEditor.tsx); the file's
 * own app is one click away too.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, PencilLine } from 'lucide-react';
import { DriveEditor } from './DriveEditor';
import { Modal } from '../components/kit';
import { EmailFrame, EmailText } from '../components/EmailBody';
import { api } from './api';

type Viewed = Awaited<ReturnType<typeof api.viewFile>>;

export function FileViewer({ itemId, name, onClose }: { itemId: string; name: string; onClose: () => void }) {
  const [viewed, setViewed] = useState<Viewed | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let gone = false;
    api
      .viewFile(itemId)
      .then((v) => !gone && setViewed(v))
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
  }, [itemId]);
  const v = viewed?.view;
  if (editing && viewed?.edit) return <DriveEditor itemId={itemId} name={viewed.name} app={viewed.edit.app} appName={viewed.app} link={viewed.link} native={viewed.edit.native} onClose={() => setEditing(false)} />;
  return (
    <Modal
      open
      onClose={onClose}
      width={v?.kind === 'sheet' ? 1100 : 860}
      title={viewed?.name ?? name}
      description={viewed ? `${viewed.type} · ${viewed.app}${viewed.edit ? '' : ' · read only'}` : undefined}
      footer={
        <>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
          {viewed?.edit && (
            <button className="btn btn-sm btn-primary" onClick={() => setEditing(true)} title={viewed.edit.saves ? `Edit it here; Save goes back to ${viewed.app}` : 'Open it in Timmy’s editor to read or download'}>
              <PencilLine size={14} />
              {viewed.edit.saves ? 'Edit in Timmy' : 'Open in Timmy’s editor'}
            </button>
          )}
          {viewed?.link && (
            <a className={`btn btn-sm${viewed.edit ? '' : ' btn-primary'}`} href={viewed.link} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} />
              Open in {viewed.app}
            </a>
          )}
        </>
      }
    >
      {error ? (
        <p className="live-error" role="alert">
          {error}
        </p>
      ) : !v ? (
        <p className="fv-note" role="status">
          Opening the file…
        </p>
      ) : v.kind === 'doc' ? (
        <div className="mail-frame-wrap fv-doc">
          <EmailFrame html={v.html} images={false} title={viewed!.name} />
        </div>
      ) : v.kind === 'sheet' ? (
        v.rows.length ? (
          <div className="fv-sheet-wrap">
            <table className="fv-sheet">
              <thead>
                <tr>
                  <th aria-label="Row" />
                  {v.rows[0]!.map((cell, i) => (
                    <th key={i}>{cell}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {v.rows.slice(1).map((row, r) => (
                  <tr key={r}>
                    <th scope="row">{r + 2}</th>
                    {v.rows[0]!.map((_h, c) => (
                      <td key={c}>{row[c] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {v.more && <p className="fv-note">The first 200 rows of the first sheet. Open it in {viewed!.app} for the rest.</p>}
          </div>
        ) : (
          <p className="fv-note">The first sheet is empty.</p>
        )
      ) : v.kind === 'slides' ? (
        <ol className="fv-slides">
          {v.slides.map((s, i) => (
            <li key={i} className="fv-slide">
              <span className="fv-slide-num">Slide {i + 1}</span>
              <EmailText text={s || '(no text)'} />
            </li>
          ))}
        </ol>
      ) : v.kind === 'text' ? (
        <div className="fv-text">
          <EmailText text={v.text} />
        </div>
      ) : (
        <p className="fv-note">{v.reason}</p>
      )}
    </Modal>
  );
}
