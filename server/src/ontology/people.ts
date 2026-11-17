/**
 * Shows the people on the map on the People screen. A person Timmy has seen in the mail appears there as
 * someone "not tracked yet", with how often they were in touch lately, so the person can choose who to keep up with.
 *
 * Timmy only adds people and keeps their counts current. A contact the person edited, tracked or made
 * themselves is theirs: nothing typed by hand is overwritten.
 */
import type { Contact } from '../../../src/data/ws-types';
import { mutate } from '../state/mutate';
import { recentPeople } from './ontology';

/** Ids are checked wherever a record is saved; an address with unusual characters is left off the screen rather than bent to fit. */
const SAFE_ID = /^[\w.:@+-]{1,200}$/;

export async function projectPeople(workspaceId: string): Promise<number> {
  const people = await recentPeople(workspaceId);
  const seen = new Set(people.map((p) => p.email));
  return mutate(workspaceId, 'ontology', async (_tx, loaded) => {
    const contacts: Record<string, Contact> = { ...loaded.state.ws.contacts };
    // A contact typed in by hand may have no address; it is simply not matched.
    const byEmail = new Map(Object.values(contacts).filter((c) => typeof c.email === 'string').map((c) => [c.email.toLowerCase(), c]));
    let changed = 0;
    for (const p of people) {
      const cur = byEmail.get(p.email);
      if (cur) {
        const next: Contact = {
          ...cur,
          emails: p.emails,
          ...(cur.last && new Date(cur.last).getTime() >= p.last.getTime() ? {} : { last: p.last }),
          // Blanks are filled in; anything already there stays as it is.
          ...(!cur.company && p.company ? { company: p.company } : {}),
          ...((!cur.name || cur.name === cur.email) && p.name ? { name: p.name } : {}),
        };
        if (JSON.stringify(next) !== JSON.stringify(cur)) {
          contacts[cur.id] = next;
          changed++;
        }
        continue;
      }
      const id = `mail:${p.email}`;
      if (!SAFE_ID.test(id)) continue;
      contacts[id] = { id, name: p.name || p.email, email: p.email, ...(p.company ? { company: p.company } : {}), last: p.last, emails: p.emails, auto: true };
      changed++;
    }
    // Someone Timmy added from mail that is no longer stored (its account was disconnected) leaves again,
    // unless the person chose to track them.
    for (const c of Object.values(contacts)) {
      if (c.auto && !c.tracked && !seen.has(c.email.toLowerCase())) {
        delete contacts[c.id];
        changed++;
      }
    }
    if (!changed) return { result: 0 };
    return { state: { ...loaded.state, ws: { ...loaded.state.ws, contacts } }, result: changed };
  });
}
