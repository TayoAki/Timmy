import { useStore } from '../state/store';
import { Modal } from './kit';

/** Quick capture (⌘J): a task or a note, filed into the review queue. Owned by the Tasks area. */
export function QuickCapture() {
  const { state, dispatch } = useStore();
  return (
    <Modal open={state.capture} onClose={() => dispatch({ type: 'capture', open: false })} title="Quick capture">
      <p className="muted">Coming soon.</p>
    </Modal>
  );
}
