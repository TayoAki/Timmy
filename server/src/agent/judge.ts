import { config } from '../config';
import { reachesSomeoneElse } from '../gateway/policy';
import { log } from '../lib/log';
import { complete } from '../providers/model';
import { JUDGE_SYSTEM } from './prompts';

export interface JudgeInput {
  workspaceId: string;
  runId?: string;
  kind: string;
  payload: unknown;
  /** A description built by our code from the action's kind and target. Never model-written text, never fetched content. */
  action: string;
  /** What the person typed in this conversation, and nothing else. */
  userWords: string[];
  /** The run has read mail, files or web pages, any of which can carry injected instructions. */
  readOutside: boolean;
}

export interface Verdict {
  verdict: 'approve' | 'ask';
  reason: string;
}

/**
 * Auto mode's judge. It runs on a pinned model the workspace can't change, and
 * it sees only the user's own words. Anything that reaches another person is
 * answered "ask" without calling the model at all, and so is every failure.
 */
export async function judge(input: JudgeInput): Promise<Verdict> {
  if (reachesSomeoneElse(input.kind, input.payload)) return { verdict: 'ask', reason: 'This reaches someone else, so a person decides.' };
  if (!input.userWords.length) return { verdict: 'ask', reason: 'Nobody asked for this in their own words.' };
  try {
    const res = await complete({
      workspaceId: input.workspaceId,
      runId: input.runId,
      route: 'judge',
      model: config.openrouter.judgeModel,
      effort: 'low',
      maxTokens: 300,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: JSON.stringify({ action: input.action, user_messages: input.userWords.slice(-12), note: input.readOutside ? 'The assistant has read outside content during this job.' : 'The assistant has not read outside content during this job.' }) },
      ],
    });
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(res.content)?.[0] ?? '{}') as { decision?: string; reason?: string };
    if (parsed.decision === 'approve') return { verdict: 'approve', reason: String(parsed.reason ?? '').slice(0, 300) };
    return { verdict: 'ask', reason: String(parsed.reason ?? 'The judge was not sure.').slice(0, 300) };
  } catch (e) {
    log.warn('judge failed, asking the user', { error: (e as Error).message });
    return { verdict: 'ask', reason: 'The judge could not be reached.' };
  }
}
