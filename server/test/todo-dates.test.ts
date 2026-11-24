/**
 * Every to-do Timmy makes from an email has a date (src/agent/todo-dates.ts): its own, the email's, or one Timmy
 * suggests from how urgent the email is, marked as suggested. Working days only, on the workspace's own clock.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Thread } from '../../src/data/types';
import type { Task } from '../../src/data/ws-types';
import { isUrgent } from '../src/agent/read';
import { addWorkingDays, suggestedDay, withDates } from '../src/agent/todo-dates';
import { boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

const NY = 'America/New_York';
/** A moment given as a New York wall-clock time in November (UTC−5). */
const ny = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`);

describe('working days', () => {
  it('skips Saturdays and Sundays', () => {
    expect(addWorkingDays('2026-11-25', 2)).toBe('2026-11-27'); // Wednesday → Friday
    expect(addWorkingDays('2026-11-27', 1)).toBe('2026-11-30'); // Friday → Monday
    expect(addWorkingDays('2026-11-27', 2)).toBe('2026-12-01'); // Friday → Tuesday
    expect(addWorkingDays('2026-11-28', 1)).toBe('2026-11-30'); // Saturday → Monday
  });
});

describe('the day Timmy suggests', () => {
  it('urgent: today while the working day lasts, otherwise the next working day', () => {
    expect(suggestedDay(true, NY, ny('2026-11-23', '10:00'))).toBe('2026-11-23'); // Monday morning
    expect(suggestedDay(true, NY, ny('2026-11-23', '18:30'))).toBe('2026-11-24'); // Monday evening
    expect(suggestedDay(true, NY, ny('2026-11-28', '11:00'))).toBe('2026-11-30'); // Saturday
  });

  it('anything else: two working days out', () => {
    expect(suggestedDay(false, NY, ny('2026-11-23', '10:00'))).toBe('2026-11-25'); // Monday → Wednesday
    expect(suggestedDay(false, NY, ny('2026-11-26', '09:00'))).toBe('2026-11-30'); // Thursday → Monday
  });

  it('is read on the workspace’s clock: late Monday evening in New York is already Tuesday in UTC', () => {
    const at = ny('2026-11-23', '21:00'); // 02:00 UTC on Tuesday
    expect(suggestedDay(false, NY, at)).toBe('2026-11-25');
    expect(suggestedDay(false, 'UTC', at)).toBe('2026-11-26');
  });
});

describe('a date for each to-do', () => {
  const todo = (extra: Partial<Task> = {}): Task => ({ id: 'tsk-1', title: 'Send the deck', status: 'todo', priority: 'normal', created: new Date(), ...extra });
  const now = ny('2026-11-23', '10:00');

  it('keeps the to-do’s own date, and is not marked suggested', () => {
    const own = new Date('2026-12-01T17:00:00Z');
    const [t] = withDates([todo({ due: own })], { due: new Date('2026-11-30T17:00:00Z') }, false, NY, now);
    expect(t!.due).toEqual(own);
    expect(t!.dueSuggested).toBeUndefined();
  });

  it('takes the date the email asks for in general, and is not marked suggested', () => {
    const asked = new Date('2026-11-30T17:00:00Z');
    const [t] = withDates([todo()], { due: asked }, false, NY, now);
    expect(t!.due).toEqual(asked);
    expect(t!.dueSuggested).toBeUndefined();
  });

  it('otherwise suggests one, at 5 PM on the workspace’s clock, marked suggested', () => {
    const [t] = withDates([todo()], {}, false, NY, now);
    expect(t!.dueSuggested).toBe(true);
    expect(t!.due!.toISOString()).toBe('2026-11-25T22:00:00.000Z'); // Wednesday, 5 PM in New York
    const [u] = withDates([todo()], {}, true, NY, now);
    expect(u!.due!.toISOString()).toBe('2026-11-23T22:00:00.000Z'); // urgent: today, 5 PM
  });
});

describe('urgent, as the app ranks it', () => {
  const thread = (extra: Partial<Thread> = {}): Thread => ({ id: 'th-1', subject: 'Deck', box: 'inbox', participants: ['mail:dana@acme.test', 'me'], messages: [{ id: 'm1', from: 'mail:dana@acme.test', to: ['me'], at: new Date(), body: ['Can you send the deck?'] }], ask: '', ...extra });
  const state = { ws: { contacts: {}, events: {} }, deals: {}, rules: [] } as never;

  it('an email due today is urgent; a plain one is not', () => {
    const today = new Date();
    today.setHours(23, 59, 0, 0);
    expect(isUrgent(thread({ due: today }), state)).toBe(true);
    expect(isUrgent(thread(), state)).toBe(false);
  });
});

describe('to-dos made from mail get their date', () => {
  let w: Client;
  let box: { connectionId: string; account: string };
  const deliver = async (subject: string, body: string) => {
    const d = fake().deliver(box.account, { from: 'Dana Whitfield <dana@acme.test>', subject, body });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
  };
  const tasks = async () => Object.values((await w.state()).ws.tasks) as Task[];
  const zone = async () => (await rows<{ timezone: string }>('select timezone from workspace where id = $1', [w.workspaceId]))[0]!.timezone;

  beforeAll(async () => {
    await boot();
  });
  beforeEach(async () => {
    model().reset();
    jobs().queue = [];
    w = await newWorkspace('Dates');
    box = await connectGmail(w, 'me@mycompany.test');
    await jobs().drain();
  });

  it('an ask with no date gets one two working days out, marked suggested; one with a date keeps it', async () => {
    await deliver('Deck', 'Hi,\n\nWhen you can, send the board deck.\n\nDana');
    await deliver('SOW', 'Hi,\n\nPlease send the signed SOW by 2026-11-20.\n\nDana');
    const all = await tasks();
    const deck = all.find((t) => t.title === 'Send the board deck')!;
    const sow = all.find((t) => t.title === 'Send the signed SOW')!;
    expect(deck.dueSuggested).toBe(true);
    // The workspace's own clock decides which day "two working days out" is.
    const tz = await zone();
    expect(new Date(deck.due!).toLocaleDateString('en-CA', { timeZone: tz })).toBe(suggestedDay(false, tz));
    expect(sow.dueSuggested).toBeUndefined();
    expect(new Date(sow.due!).toISOString().slice(0, 10)).toBe('2026-11-20');
  });

  it('“Make a to-do” on an email that names no date gets a suggested one too', async () => {
    await deliver('Wireframes', 'Here they are.\n\nPlease share the brand guide with the team.');
    const thread = (await w.state()).threads.find((t) => t.subject === 'Wireframes')!;
    const r = await w.post('/api/v1/mail/todo', { thread: thread.id });
    expect(r.status).toBe(200);
    const made = (await tasks()).find((t) => t.title === 'Share the brand guide with the team')!;
    expect(made.dueSuggested).toBe(true);
    expect(made.due).toBeDefined();
  });

  it('changing the date makes it the person’s own; the mark can only be true', async () => {
    await deliver('Deck', 'When you can, send the board deck.');
    const deck = (await tasks()).find((t) => t.title === 'Send the board deck')!;
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id: deck.id, patch: { dueSuggested: 'yes' } }] })).ok).toBe(false);
    const mine = new Date('2026-12-04T17:00:00Z');
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: { ...deck, due: mine, dueSuggested: undefined } }] })).ok).toBe(true);
    const after = (await tasks()).find((t) => t.id === deck.id)!;
    expect(after.dueSuggested).toBeUndefined();
    expect(new Date(after.due!).toISOString()).toBe(mine.toISOString());
  });
});
