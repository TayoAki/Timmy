/**
 * The stand-in model: scripted turns for tests, and a few plain rules for everything else, enough to drive the
 * chat, reading, drafting and the judge end to end without a model. The server uses it in place of OpenRouter when
 * `config.fakeProviders` is on, as chosen in providers/model.ts. Tests reach it through `fakeModel()`.
 */
import type { ModelProvider, ModelRequest, ModelResponse } from '../providers/model';
import { fakeThingsAnswer, fakeThingsQuestion, fakeThingsRead } from './model-things';

export type FakeTurn = { content?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] } | ((req: ModelRequest) => { content?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] });

/**
 * A scripted model for tests. Queue the turns you want with `script`; with an
 * empty script it follows a few plain rules, enough to drive the chat end to end.
 * Every request is kept in `requests` so tests can check what a prompt contained.
 */
export class FakeModel implements ModelProvider {
  script: FakeTurn[] = [];
  requests: ModelRequest[] = [];
  private seq = 0;

  reset() {
    this.script = [];
    this.requests = [];
  }

  async complete(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    const turn = typeof next === 'function' ? next(req) : next ?? this.rules(req);
    const content = turn.content ?? '';
    for (const word of content.match(/\S+\s*/g) ?? []) onText?.(word);
    const tokensIn = Math.ceil(JSON.stringify(req.messages).length / 4);
    const tokensOut = Math.ceil(content.length / 4) + 20;
    return {
      content,
      toolCalls: (turn.toolCalls ?? []).map((t) => ({ id: `call_fake_${++this.seq}`, name: t.name, arguments: JSON.stringify(t.arguments) })),
      usage: { tokensIn, tokensOut, tokensReasoning: 0, tokensCached: 0, tokensCacheWrite: 0, costUsd: (tokensIn * 4 + tokensOut * 20) / 1_000_000 },
      model: req.model,
      provider: 'fake',
      id: `gen_fake_${this.seq}`,
    };
  }

  private rules(req: ModelRequest): { content?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] } {
    // The stand-in judge approves only the one phrasing the stand-in chat rule below files on, and asks about everything else.
    if (req.route === 'judge') {
      const words = (JSON.parse(req.messages[req.messages.length - 1]!.content) as { user_messages?: string[] }).user_messages ?? [];
      const clear = /^archive thread \S+$/i.test((words[words.length - 1] ?? '').trim());
      return { content: clear ? '{"decision":"approve","reason":"The user asked for exactly this."}' : '{"decision":"ask","reason":"The stand-in judge asks unless the request is exact."}' };
    }
    // A look back through recent mail for a newly accepted kind is the same read (see ontology/reread.ts).
    if (req.route === 'read' || req.route === 'reread') {
      // The stand-in reads two plain patterns out of the thread: "should we A or B?" and "I'll send X by <date>".
      const content = req.messages[req.messages.length - 1]!.content;
      const mail = content.slice(content.indexOf('<untrusted source="mail">'));
      const choice = /[Ss]hould (?:we|I) ([^?."\\]{3,60}?) or ([^?."\\]{3,60}?)\?/.exec(mail);
      const promise = /((?:I will|I'll|We will|We'll) (?:send|share|deliver) [^."\\]{3,80}? by (\d{4}-\d{2}-\d{2}))/.exec(mail);
      const question = choice ? `Should we ${choice[1]} or ${choice[2]}?` : '';
      const made = [...content.slice(0, content.indexOf('<untrusted source="mail">')).matchAll(/^(\d+)\. “([^”]+)”/gm)];
      const same = made.find((m) => m[2] === question);
      const price = /(\$\d[\d,.]*) per seat/.exec(mail);
      const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1);
      return {
        content: JSON.stringify({
          box: 'follow-up',
          confidence: 'medium',
          effort: 'quick',
          ask: 'They wrote to you and are waiting for an answer.',
          reason: 'A person asked a question.',
          due: null,
          commitments: promise ? [{ who: 'them', what: promise[1]!.replace(/^(I will|I'll|We will|We'll) /, '').replace(/ by \d{4}-\d{2}-\d{2}$/, ''), due: promise[2], quote: promise[1] }] : [],
          decision: choice ? { question, options: [cap(choice[1]!), cap(choice[2]!)], facts: [...(price ? [['Price', price[1], price[0]]] : []), ['Made up', '$1', 'a sentence that is not in the thread at all']], same_as: same ? Number(same[1]) : null } : null,
          // To-dos from sentences like "Please send the signed SOW by 2026-11-20." (and one that is not in the mail at all).
          todos: [...mail.matchAll(/(Please ([a-z][^."\\]{3,80}?) by (\d{4}-\d{2}-\d{2})\.)/g)].map((m): { what: string; due: string | null; quote: string } => ({ what: cap(m[2]!), due: m[3]!, quote: m[1]! }))
            // An ask that names no date: "When you can, send the deck."
            .concat([...mail.matchAll(/(When you can, ([a-z][^."\\]{3,80}?)\.)/g)].map((m) => ({ what: cap(m[2]!), due: null, quote: m[1]! })))
            .concat(/Please [a-z]/.test(mail) ? [{ what: 'Wire money to an account', due: null, quote: 'Please wire the money today.' }] : []),
          // Tracked things and untracked kinds, from lines like "Deal: company Acme Corp; value $40,000." (see model-things.ts).
          ...fakeThingsRead(content),
          // The project the mail names, by its name or its client's, when the user's projects are listed.
          project: fakeProjectPick(content, mail),
          // Maybe a project: the mail names a project's first word (five letters or more) but not the project itself.
          maybe_project: fakeProjectPick(content, mail) ? null : fakeProjectGuess(content, mail),
        }),
      };
    }
    // A to-do asked for on one email: the first "Please …" sentence in it, with its date when it gives one.
    if (req.route === 'todo') {
      const content = req.messages[req.messages.length - 1]!.content;
      const m = /(Please ([a-z][^."\\]{3,80}?)(?: by (\d{4}-\d{2}-\d{2}))?[.!])/.exec(content);
      return { content: JSON.stringify({ todos: m ? [{ what: m[2]![0]!.toUpperCase() + m[2]!.slice(1), due: m[3] ?? null, quote: m[1] }] : [] }) };
    }
    // Lines to bill from sentences like "That's 120 seats at $58 per seat." (and one resting on nothing).
    if (req.route === 'invoice') {
      const content = req.messages[req.messages.length - 1]!.content;
      const mail = content.slice(content.indexOf('<untrusted source="mail">'));
      const lines = [...mail.matchAll(/([^."\\\n]*?(\d+) ([a-z][a-z ]{2,40}?) at \$(\d[\d,]*(?:\.\d{2})?)[^."\\\n]*\.)/g)].map((m) => ({ description: m[3]![0]!.toUpperCase() + m[3]!.slice(1), qty: Number(m[2]), unit_price: m[4]!.replace(/,/g, ''), quote: m[1]!.trim() }));
      return { content: JSON.stringify({ intro: lines.length ? 'For the work in this email.' : '', lines: [...lines, { description: 'Made-up line', qty: 1, unit_price: '999', quote: 'A sentence that is not in the mail at all.' }] }) };
    }
    if (req.route === 'summary') {
      const listed = [...req.messages[req.messages.length - 1]!.content.matchAll(/^\[([\w.:@+-]+)\] (.+)$/gm)].map((m) => ({ id: m[1]!, text: m[2]! }));
      return {
        content: JSON.stringify({
          lines: listed.length
            ? [
                ...listed.slice(0, 2).map((b) => ({ text: b.text.slice(0, 120), blocks: [b.id] })),
                // Two lines a careless model might write: a figure that is not on the page, and a line resting on nothing.
                { text: 'The budget is $999,999.', blocks: [listed[0]!.id] },
                { text: 'Everyone agreed.', blocks: ['no-such-block'] },
              ]
            : [],
        }),
      };
    }
    if (req.route === 'draft') return { content: JSON.stringify({ body: 'Thanks for your message. I will come back to you on this shortly.\n\nBest' }) };
    // Naming a group a project scan found: one project, called after its company (or "Team" among colleagues).
    if (req.route === 'detect') {
      const text = req.messages[req.messages.length - 1]!.content;
      const company = /"company":"([^"]+)"/.exec(text)?.[1];
      const count = (text.match(/"\d+\. /g) ?? []).length;
      const name = company ? `${company} work` : 'Team work';
      return { content: JSON.stringify({ projects: [{ name, kind: company ? 'client' : 'internal', summary: `Work${company ? ` with ${company}` : ' with colleagues'}.`, threads: Array.from({ length: count }, (_, i) => i + 1) }] }) };
    }
    const last = req.messages[req.messages.length - 1]!;
    const has = (name: string) => req.tools?.some((t) => t.name === name);
    if (last.role === 'tool') {
      if (last.content.includes('<untrusted source="things">')) return { content: fakeThingsAnswer(last.content) };
      if (last.content.includes('<untrusted source="people">')) {
        const person = /"name":"([^"]+)","email":"([^"]+)"(?:,"also":\[[^\]]*\])?(?:,"company":"([^"]+)")?/.exec(last.content);
        const owed = /"what":"([^"]+)","due":(?:"([^"]+)"|null)/.exec(last.content);
        if (last.content.includes('"commitments":[') && !person) return { content: owed ? `Open: ${owed[1]}${owed[2] ? `, due ${owed[2]}` : ''}.` : 'Nothing is open.' };
        return { content: person ? `${person[1]} (${person[2]})${person[3] ? ` works at ${person[3]}` : ''}.${owed ? ` Open: ${owed[1]}.` : ''}` : 'I don’t know anyone by that name.' };
      }
      if (last.content.includes('<untrusted source="file">')) {
        const said = /"text":"((?:[^"\\]|\\.)*)"/.exec(last.content);
        return { content: said ? `It says: ${(JSON.parse(`"${said[1]}"`) as string).split('\n')[0]}` : 'The file was empty.' };
      }
      if (last.content.includes('<untrusted source="files">')) {
        // Asked what a file says: the search found it, so the next step is to read it.
        const wanted = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        const id = /"file":"([^"]+)"/.exec(last.content)?.[1];
        if (/what does (?:the |my )?(?:file|doc|document) .+ say/i.test(wanted) && id && has('read_file')) return { toolCalls: [{ name: 'read_file', arguments: { file: id } }] };
        const file = /"name":"([^"]+)","kind":"([^"]+)"/.exec(last.content);
        return { content: file ? `I found a file: “${file[1]}” (${file[2]}).` : 'I couldn’t find a file with that name.' };
      }
      const found = /"subject":"([^"]+)"/.exec(last.content)?.[1];
      return { content: found ? `I found it: “${found}”.` : last.content.includes('"results":[]') ? 'I couldn’t find any mail about that.' : 'Done.' };
    }
    // The chat endpoint puts a context block ahead of the question; the rules look at the question itself.
    const asked = last.content.replace(/^<context>[\s\S]*?<\/context>\s*/, '').replace(/^<untrusted source="screen">[\s\S]*?<\/untrusted>\s*/, '').trim();
    const text = asked.toLowerCase();
    const send = /^send (?:an email )?to (\S+@\S+) saying (.+)$/i.exec(asked);
    const file = /^(archive|file) thread (\S+)$/i.exec(asked);
    const who = /^who is (.+?)[?.!]*$/i.exec(asked);
    if (who && has('lookup_person')) return { toolCalls: [{ name: 'lookup_person', arguments: { query: who[1] } }] };
    if (/^what am i waiting on[?.!]*$/i.test(asked) && has('list_commitments')) return { toolCalls: [{ name: 'list_commitments', arguments: {} }] };
    const things = fakeThingsQuestion(asked);
    if (things && has('find_things')) return { toolCalls: [{ name: 'find_things', arguments: { type: things } }] };
    const says = /^what does (?:the |my )?(?:file|doc|document) (.+?) say[?.!]*$/i.exec(asked);
    if (says && has('search_files')) return { toolCalls: [{ name: 'search_files', arguments: { query: says[1] } }] };
    const lookFor = /^find (?:the |my )?(?:file|doc|document) (?:called |named |about )?(.+?)[?.!]*$/i.exec(asked);
    if (lookFor && has('search_files')) return { toolCalls: [{ name: 'search_files', arguments: { query: lookFor[1] } }] };
    if (file && has('file_thread')) return { toolCalls: [{ name: 'file_thread', arguments: { id: file[2], box: file[1]!.toLowerCase() === 'archive' ? 'archived' : 'follow-up' } }] };
    // Sorting rules said in plain words: "always archive mail from linkedin.com", "never archive mail from dana@acme.com",
    // "put mail from acme.com in the Acme website project".
    const always = /^always (archive|show me) (?:mail|email|emails) from (\S+?)[.!]*$/i.exec(asked) ?? /^never (archive) (?:mail|email|emails) from (\S+?)[.!]*$/i.exec(asked);
    if (always && has('save_rule')) return { toolCalls: [{ name: 'save_rule', arguments: { from: [always[2]], box: /^never/i.test(asked) || /show me/i.test(always[1]!) ? 'follow-up' : 'archived' } }] };
    const into = /^put (?:mail|email|emails) from (\S+) in the (.+?) project[.!]*$/i.exec(asked);
    if (into && has('save_rule')) return { toolCalls: [{ name: 'save_rule', arguments: { from: [into[1]], project: into[2] } }] };
    if (send && has('send_email')) return { toolCalls: [{ name: 'send_email', arguments: { to: [send[1]], subject: 'A note from Timmy', body: send[2] } }] };
    if (/urgent/.test(text) && has('show_urgent')) return { content: 'Here is what needs you first.', toolCalls: [{ name: 'show_urgent', arguments: { limit: 5 } }] };
    if (/(mail|email|inbox|find|about|from)/.test(text) && has('search_mail')) return { toolCalls: [{ name: 'search_mail', arguments: { query: asked.replace(/[?.!]/g, '').split(/\s+/).slice(-3).join(' ') } }] };
    return { content: 'I’m not sure how to help with that yet.' };
  }
}

/** The stand-in's project pick: the listed project whose name or client the mail mentions, else none. */
function fakeProjectGuess(content: string, mail: string): number | null {
  const block = /<untrusted source="projects">([\s\S]*?)<\/untrusted>/.exec(content)?.[1] ?? '';
  for (const m of block.matchAll(/^(\d+)\. (.+?)(?: \(client: ([^)]+)\))?(?: — .*)?$/gm)) {
    const first = m[2]!.split(' ')[0]!;
    if (first.length >= 5 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(mail)) return Number(m[1]);
  }
  return null;
}

function fakeProjectPick(content: string, mail: string): number | null {
  const block = /<untrusted source="projects">([\s\S]*?)<\/untrusted>/.exec(content)?.[1] ?? '';
  const lower = mail.toLowerCase();
  for (const m of block.matchAll(/^(\d+)\. (.+?)(?: \(client: ([^)]+)\))?(?: — .*)?$/gm)) {
    if (lower.includes(m[2]!.toLowerCase()) || (m[3] && lower.includes(m[3].toLowerCase()))) return Number(m[1]);
  }
  return null;
}
