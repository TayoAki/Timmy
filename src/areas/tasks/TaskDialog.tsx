import { Modal } from '../../components/kit';
import type { Task } from '../../data/ws-types';

/** Create or edit a task. Owned by the Tasks area; used from mail, projects and people. */
export function TaskDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: Partial<Task> }) {
  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Edit task' : 'New task'}>
      <p className="muted">{initial?.title ?? 'Task form coming soon.'}</p>
    </Modal>
  );
}
