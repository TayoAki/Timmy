/**
 * Drive and OneDrive files into projects, as they arrive. A file on the workspace's list that belongs to no project yet
 * is linked to the one active project it plainly belongs to:
 *   - its owner is someone (or from a company) whose mail the project claims (project_key): the strongest sign;
 *   - its name carries the project's name, its client's name, or a word only that project's name has;
 *   - what it says (when Timmy keeps its words) names the project or its client, which counts for less.
 * A file goes in only when one project clearly scores best; a tie, or a single weak sign, leaves it where it is.
 * Plain code, no model: it costs nothing and a file can't talk it into anything. Nothing is written to a Drive: a link
 * is Timmy's own record (project_link), shown on the project's page and in the files list.
 */
import { withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { log } from '../lib/log';
import { companyDomain } from '../ontology/ontology';
import { readState } from '../state/mutate';

/** Words that say nothing about which project a file is for. */
const STOP = new Set(
  'about after again also and any are back been before being but can could did does done for from get got had has have here how into its just know let like make more need next not now one our out over please see some still than that the their them then there these they this time today update was week what when where which who why will with would you your project projects team plan notes draft final copy new old misc general file files doc docs document sheet slides deck'.split(' '),
);

const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

interface Candidate {
  id: string;
  /** The project's name and its client's, as phrases to look for. */
  phrases: string[];
  /** Words only this project's name or client has. */
  own: string[];
}

/** How strongly a file belongs to a project. Exported for the tests. */
export function scoreFile(file: { name: string; owner: string; text: string | null }, p: Candidate, claims: Set<string>): number {
  let score = 0;
  if (claims.size) {
    const owner = file.owner.toLowerCase();
    const domain = companyDomain(owner);
    if ((domain && claims.has(`org:${domain}`)) || claims.has(`person:${owner}`)) score += 3;
  }
  const name = norm(file.name);
  if (p.phrases.some((ph) => name.includes(ph))) score += 3;
  else if (p.own.some((w) => name.includes(` ${w} `))) score += 2;
  if (file.text) {
    const said = norm(file.text.slice(0, 20000));
    if (p.phrases.some((ph) => said.includes(ph))) score += 1;
  }
  return score;
}

/**
 * Links the workspace's unlinked files to their projects. `itemIds` narrows it to some files (just listed or just
 * read); without it, the most recent unlinked files are looked at. Returns how many were linked.
 */
export async function linkFilesToProjects(workspaceId: string, itemIds?: string[]): Promise<number> {
  const { state } = await readState(workspaceId);
  const active = Object.values(state.ws.projects).filter((p) => p.status === 'active');
  if (!active.length) return 0;
  // A project's own words: from its name and its client's, minus the ones another project's name also has.
  const seen = new Map<string, number>();
  const wordSets = active.map((p) => new Set([...wordsOf(p.name), ...wordsOf(p.client ?? '')]));
  for (const ws of wordSets) for (const w of ws) seen.set(w, (seen.get(w) ?? 0) + 1);
  const candidates: Candidate[] = active.map((p, i) => ({
    id: p.id,
    phrases: [p.name, p.client ?? ''].map((x) => norm(x)).filter((x) => x.trim().length >= 4 && x.trim().split(' ').some((w) => !STOP.has(w))),
    own: [...wordSets[i]!].filter((w) => w.length >= 5 && seen.get(w) === 1),
  }));

  return withWorkspace({ workspaceId }, async (tx) => {
    const keys = (await tx.query(`select key, project_id from project_key where workspace_id = $1`, [workspaceId])).rows as { key: string; project_id: string }[];
    const claimsOf = new Map<string, Set<string>>();
    for (const k of keys) (claimsOf.get(k.project_id) ?? claimsOf.set(k.project_id, new Set()).get(k.project_id)!).add(k.key);
    const { rows } = await tx.query(
      `select i.id, i.subject, coalesce(i.sender, '') as owner, left(b.text, 20000) as text
       from item i join connection c on c.id = i.connection_id left join item_body b on b.item_id = i.id
       where i.workspace_id = $1 and i.kind = 'file' and c.status = 'active'
         and not exists (select 1 from project_link l where l.workspace_id = i.workspace_id and l.item_id = i.id)
         ${itemIds ? 'and i.id = any($2::text[])' : ''}
       order by i.occurred_at desc limit 2000`,
      itemIds ? [workspaceId, itemIds] : [workspaceId],
    );
    const linked: { item: string; project: string }[] = [];
    for (const f of rows as { id: string; subject: string | null; owner: string; text: string | null }[]) {
      const file = { name: f.subject ?? '', owner: f.owner, text: f.text };
      const scored = candidates.map((p) => ({ id: p.id, score: scoreFile(file, p, claimsOf.get(p.id) ?? new Set()) })).sort((a, b) => b.score - a.score);
      const [best, second] = scored;
      if (!best || best.score < 2 || (second && second.score === best.score)) continue;
      linked.push({ item: f.id, project: best.id });
    }
    for (const l of linked) await tx.query(`insert into project_link (workspace_id, project_id, item_id) values ($1, $2, $3) on conflict do nothing`, [workspaceId, l.project, l.item]);
    if (linked.length) {
      await audit(tx, workspaceId, { actor: 'timmy', action: 'projects.files_linked', detail: { files: linked.length, projects: [...new Set(linked.map((l) => l.project))] } });
      log.info('files linked to projects', { workspaceId, files: linked.length });
    }
    return linked.length;
  });
}
