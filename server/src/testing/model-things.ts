/**
 * What the stand-in model "reads" about tracked things, so tests can drive the real pipeline without a model.
 *
 * It knows one plain pattern: a line that names a kind and then gives fields, such as
 *
 *     Deal: company Acme Corp; value $40,000; stage negotiation.
 *
 * A kind the request lists as tracked comes back as a thing. Any other kind comes back as a kind the thread is
 * about. Like a careless model it also invents: a value the thread never gave for each field the line left out,
 * and one more thing, named after the subject line, resting on a sentence that is nowhere in the thread.
 * The server has to drop both.
 */

interface Listed {
  name: string;
  fields: string[];
}

const block = (content: string, source: string) => {
  const open = `<untrusted source="${source}">\n`;
  const start = content.indexOf(open);
  const end = start < 0 ? -1 : content.indexOf('\n</untrusted>', start);
  return end < 0 ? '' : content.slice(start + open.length, end);
};

/** The kinds the request says the workspace tracks: "- Deal: company, value, stage, close date". */
const listedKinds = (content: string): Listed[] => [...block(content, 'types').matchAll(/^- ([^:\n]+): (.+)$/gm)].map((m) => ({ name: m[1]!, fields: m[2]!.split(', ') }));

/** "close date 2026-12-01" → ["close date", "2026-12-01"], by the longest field name it starts with, or else its first word. */
function fieldOf(part: string, known: string[]): [string, string] | null {
  const label = [...known].sort((a, b) => b.length - a.length).find((f) => part.toLowerCase().startsWith(`${f.toLowerCase()} `)) ?? part.split(' ')[0]!;
  const value = part.slice(label.length).trim();
  return value ? [label.toLowerCase(), value] : null;
}

export function fakeThingsRead(content: string): { things: unknown[]; new_kinds: unknown[] } {
  const kinds = listedKinds(content);
  let bodies: string[] = [];
  let subject = '';
  try {
    const mail = JSON.parse(block(content, 'mail')) as { subject: string; messages: { body: string }[] };
    bodies = mail.messages.map((m) => m.body);
    subject = mail.subject;
  } catch {
    /* nothing readable, nothing found */
  }
  const things: unknown[] = [];
  const newKinds: unknown[] = [];
  for (const line of bodies.join('\n').matchAll(/^([A-Z][A-Za-z]*(?: [a-z]+)?): ([a-z].*)\.$/gm)) {
    const kind = kinds.find((k) => k.name.toLowerCase() === line[1]!.toLowerCase());
    const pairs = line[2]!.split('; ').map((part) => fieldOf(part, kind?.fields ?? [])).filter((p): p is [string, string] => !!p);
    if (!pairs.length) continue;
    if (kind) {
      const fields = Object.fromEntries(pairs);
      for (const f of kind.fields) fields[f] ??= 'made up by the stand-in';
      things.push({ kind: kind.name, fields, quote: line[0] });
    } else {
      newKinds.push({ kind: line[1], name: pairs[0]![1], fields: pairs, quote: line[0] });
    }
  }
  // Its name really is in the thread (it is the subject), so only the missing sentence can stop it.
  if (kinds[0] && subject) things.push({ kind: kinds[0].name, fields: { [kinds[0].fields[0]!]: subject }, quote: 'This sentence is not in the thread at all.' });
  return { things: things.slice(0, 4), new_kinds: newKinds.slice(0, 3) };
}

/** A question the stand-in answers by looking up tracked things: "which deals do you know about?" */
export const fakeThingsQuestion = (asked: string) => /^(?:which|what) (.+?) (?:do you know(?: about)?|are you tracking|do you track)[?.!]*$/i.exec(asked)?.[1];

/** The stand-in's answer from the lookup's result: each thing with its fields and the sentence behind it. */
export function fakeThingsAnswer(result: string): string {
  let things: { kind: string; name: string; fields: Record<string, string>; rests_on: { sentence: string }[] }[] = [];
  try {
    things = (JSON.parse(result.split('\n')[1] ?? '{}') as { things?: typeof things }).things ?? [];
  } catch {
    /* an answer that can't be read is an empty one */
  }
  if (!things.length) return 'I don’t know of any.';
  return things.map((t) => `${t.kind}: ${t.name} (${Object.entries(t.fields).map(([label, value]) => `${label} ${value}`).join(', ')}). It rests on “${t.rests_on[0]?.sentence ?? ''}”`).join(' ');
}
