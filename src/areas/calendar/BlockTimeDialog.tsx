import { Modal } from '../../components/kit';

/**
 * Reserve a calendar block for a piece of work. Owned by the Calendar area;
 * used from tasks, threads and projects. Links the event to the task/thread.
 */
export function BlockTimeDialog({
  open,
  onClose,
  title,
  task,
  thread,
  minutes = 60,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  task?: string;
  thread?: string;
  minutes?: number;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Block time">
      <p className="muted">
        {title} · {minutes} min {task ?? ''} {thread ?? ''}
      </p>
    </Modal>
  );
}
