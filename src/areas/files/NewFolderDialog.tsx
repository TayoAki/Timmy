import { Check } from 'lucide-react';
import { useState } from 'react';
import { Folder as FolderGlyph, tint } from '../../components/common';
import { Field, Modal } from '../../components/kit';
import { ws, useStore } from '../../state/store';
import { MAX_DEPTH, childFolders, depthOf, folderLabel, put, uid } from '../../state/ws';
import { FOLDER_COLORS, ROOT, nextFreeNum, shortPath } from './drive';
import { FolderSelect, Group } from './pickers';

/**
 * New numbered folder. The number defaults to the next free one; 99 is kept
 * for the archive; folders stop at five levels.
 */
export function NewFolderDialog({ parent: initialParent, onClose }: { parent: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [parent, setParent] = useState(initialParent);
  const parentId = parent === ROOT ? null : parent;
  const [num, setNum] = useState(() => nextFreeNum(state.ws, parentId));
  const [name, setName] = useState('');
  const [color, setColor] = useState(FOLDER_COLORS[3]!.value);

  const depth = depthOf(state.ws, parentId) + 1;
  const tooDeep = depth > MAX_DEPTH;
  const clash = childFolders(state.ws, parentId).find((f) => f.num === num.padStart(2, '0'));
  const twoDigits = /^\d{1,2}$/.test(num);
  const n = Number(num);
  const problem = tooDeep
    ? `${shortPath(state.ws, parent)} is already ${MAX_DEPTH} levels deep. Folders stop at ${MAX_DEPTH} levels so files stay easy to find: put it in this folder, or create the new folder one level up.`
    : !twoDigits
      ? 'Use a two-digit number, 01 to 98.'
      : n === 99
        ? '99 is kept for the archive. Pick another number.'
        : n === 0
          ? 'Start at 01.'
          : clash
            ? `${folderLabel(clash)} already uses ${clash.num}. Pick another number.`
            : null;
  const hint = !problem && n > 9 && !parentId ? 'Top-level numbers rarely go above 09. Keep low numbers for the folders you open most.' : null;
  const ok = !problem && !!name.trim();

  const changeParent = (id: string) => {
    setParent(id);
    setNum(nextFreeNum(state.ws, id === ROOT ? null : id));
  };

  const create = () => {
    if (!ok) return;
    const f = { id: uid('folder'), num: num.padStart(2, '0'), name: name.trim(), parent: parentId, color };
    dispatch(ws([put('folders', f)], { toast: `Created ${folderLabel(f)} in ${shortPath(state.ws, parent)}`, undo: true }));
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New folder"
      description="Number folders when order matters. Low numbers for the ones you use most; 99 is the archive."
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ok} onClick={create}>
            Create folder
          </button>
        </>
      }
    >
      <form
        className="dr-form"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Field label="Inside" hint={tooDeep ? undefined : `Level ${depth} of ${MAX_DEPTH}`}>
          <FolderSelect value={parent} onChange={changeParent} label="Parent folder" withRoot />
        </Field>
        <div className="dr-num-name">
          <Field label="Number">
            <input
              className="input dr-num-input"
              value={num}
              inputMode="numeric"
              maxLength={2}
              onChange={(e) => setNum(e.target.value.replace(/\D/g, '').slice(0, 2))}
              aria-invalid={!!problem && !tooDeep}
            />
          </Field>
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brightwave" disabled={tooDeep} />
          </Field>
        </div>
        <Group label="Colour">
          <div className="dr-swatches" role="radiogroup" aria-label="Folder colour">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={color === c.value}
                aria-label={c.label}
                title={c.label}
                className="dr-swatch"
                style={tint(c.value)}
                onClick={() => setColor(c.value)}
              >
                {color === c.value && <Check size={13} strokeWidth={3} />}
              </button>
            ))}
          </div>
        </Group>
        <div className="dr-preview" aria-live="polite">
          <FolderGlyph color={color} size={22} />
          <span>
            <span className="dr-num">{num.padStart(2, '0') || '··'}</span>
            {name.trim() || 'Folder name'}
          </span>
        </div>
        {problem && <p className={`dr-problem${tooDeep ? ' block' : ''}`}>{problem}</p>}
        {hint && <p className="field-hint">{hint}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

