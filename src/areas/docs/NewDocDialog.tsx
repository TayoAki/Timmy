import { Modal } from '../../components/kit';
import type { DocTemplate } from '../../data/ws-types';

export interface NewDocInitial {
  template?: DocTemplate;
  project?: string;
  folder?: string;
  title?: string;
  /** Calendar event the doc is the running notes for. */
  event?: string;
}

/** Create and name a doc in one step, from a template. Owned by the Docs area. */
export function NewDocDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: NewDocInitial;
  onCreated?: (fileId: string) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="New doc">
      <p className="muted">{initial?.title ?? 'Coming soon.'}</p>
    </Modal>
  );
}
