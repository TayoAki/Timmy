import { Modal } from '../../components/kit';
import type { Contact } from '../../data/ws-types';

/** Add or edit a contact. Owned by the People area. */
export function ContactDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: Partial<Contact> }) {
  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Edit contact' : 'Add contact'}>
      <p className="muted">Coming soon.</p>
    </Modal>
  );
}
