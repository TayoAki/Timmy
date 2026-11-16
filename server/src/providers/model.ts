/**
 * The model interface. Every model call in Timmy goes through `complete`, so
 * every call gets the same treatment: zero-data-retention routing, a fallback
 * list, prompt caching, a spend check before and a cost record after.
 */
import { config } from '../config';
import { sysPool, withWorkspace } from '../db/pool';
import { log } from '../lib/log';

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, exactly as the model produced it. */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Opaque reasoning blocks some models need handed back with their tool calls. */
  reasoningDetails?: unknown[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type Effort = 'minimal' | 'low' | 'medium' | 'high';

export interface ModelRequest {
  workspaceId: string;
  /** What the call is for: ask, draft, read, judge. Cost is reported per route. */
  route: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  effort?: Effort;
  maxTokens?: number;
  runId?: string;
  /** Nobody asked for this call: Timmy is reading incoming mail or preparing the morning run on its own. */
  unattended?: boolean;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCached: number;
  tokensCacheWrite: number;
  costUsd: number;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  reasoningDetails?: unknown[];
  usage: Usage;
  /** The model that actually answered (a fallback, when the first choice was down). */
  model: string;
  provider?: string;
  id?: string;
}

export interface ModelProvider {
  complete(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResponse>;
}

export class BudgetError extends Error {}

/* ───────────── OpenRouter ───────────── */

const isClaude = (model: string) => model.startsWith('anthropic/');

/** Marks the stable prefix (system prompt and tools) and the latest turn for caching. */
function toWireMessages(messages: ChatMessage[], cache: boolean) {
  const lastIndex = messages.length - 1;
  return messages.map((m, i) => {
    const mark = cache && (m.role === 'system' || (i === lastIndex && m.role !== 'assistant'));
    const content = mark && m.content ? [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] : m.content;
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content };
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments || '{}' } })) } : {}),
        ...(m.reasoningDetails?.length ? { reasoning_details: m.reasoningDetails } : {}),
      };
    }
    return { role: m.role, content };
  });
}

/** Exposed so tests can check what would be sent without sending it. */
export function buildRequestBody(req: ModelRequest) {
  // The judge is pinned: it is never answered by another model. Other routes fall back only to models the owner has approved.
  const fallbacks = req.route === 'judge' ? [] : config.openrouter.fallbacks.filter((m) => m !== req.model);
  return {
    model: req.model,
    ...(fallbacks.length ? { models: [req.model, ...fallbacks] } : {}),
    // Mail only goes to endpoints that keep no data.
    provider: { zdr: true, data_collection: 'deny' },
    usage: { include: true },
    ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
    max_tokens: req.maxTokens ?? 4000,
    stream: true,
    messages: toWireMessages(req.messages, isClaude(req.model)),
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
  };
}

class OpenRouter implements ModelProvider {
  async complete(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResponse> {
    const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openrouter.apiKey}`, 'x-title': 'Timmy' },
      body: JSON.stringify(buildRequestBody(req)),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`The model service answered ${res.status}: ${text.slice(0, 300)}`);
    }
    let content = '';
    const calls: ToolCall[] = [];
    const reasoningDetails: unknown[] = [];
    let usage: Record<string, unknown> | undefined;
    let model = req.model;
    let provider: string | undefined;
    let id: string | undefined;

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const j = JSON.parse(data) as Record<string, unknown>;
        if (j.error) throw new Error(`The model service failed mid-answer: ${JSON.stringify(j.error).slice(0, 300)}`);
        if (typeof j.model === 'string') model = j.model;
        if (typeof j.provider === 'string') provider = j.provider;
        if (typeof j.id === 'string') id = j.id;
        if (j.usage) usage = j.usage as Record<string, unknown>;
        const delta = ((j.choices as { delta?: Record<string, unknown> }[] | undefined)?.[0]?.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onText?.(delta.content);
        }
        if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
        for (const t of (delta.tool_calls ?? []) as { index: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
          const slot = (calls[t.index] ??= { id: '', name: '', arguments: '' });
          if (t.id) slot.id = t.id;
          if (t.function?.name) slot.name = t.function.name;
          if (t.function?.arguments) slot.arguments += t.function.arguments;
        }
      }
    }
    const u = usage ?? {};
    const pd = (u.prompt_tokens_details ?? {}) as Record<string, number>;
    const cd = (u.completion_tokens_details ?? {}) as Record<string, number>;
    return {
      content,
      toolCalls: calls.filter((c) => c && c.name),
      reasoningDetails: reasoningDetails.length ? reasoningDetails : undefined,
      usage: {
        tokensIn: Number(u.prompt_tokens ?? 0),
        tokensOut: Number(u.completion_tokens ?? 0),
        tokensReasoning: Number(cd.reasoning_tokens ?? 0),
        tokensCached: Number(pd.cached_tokens ?? 0),
        tokensCacheWrite: Number(pd.cache_write_tokens ?? 0),
        costUsd: Number(u.cost ?? 0),
      },
      model,
      provider,
      id,
    };
  }
}

/* ───────────── The fake model ───────────── */

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
    if (req.route === 'read') return { content: JSON.stringify({ box: 'follow-up', confidence: 'medium', effort: 'quick', ask: 'They wrote to you and are waiting for an answer.', reason: 'A person asked a question.', due: null }) };
    if (req.route === 'draft') return { content: JSON.stringify({ body: 'Thanks for your message. I will come back to you on this shortly.\n\nBest' }) };
    const last = req.messages[req.messages.length - 1]!;
    const has = (name: string) => req.tools?.some((t) => t.name === name);
    if (last.role === 'tool') {
      const found = /"subject":"([^"]+)"/.exec(last.content)?.[1];
      return { content: found ? `I found it: “${found}”.` : last.content.includes('"results":[]') ? 'I couldn’t find any mail about that.' : 'Done.' };
    }
    // The chat endpoint puts a context block ahead of the question; the rules look at the question itself.
    const asked = last.content.replace(/^<context>[\s\S]*?<\/context>\s*/, '').replace(/^<untrusted source="screen">[\s\S]*?<\/untrusted>\s*/, '').trim();
    const text = asked.toLowerCase();
    const send = /^send (?:an email )?to (\S+@\S+) saying (.+)$/i.exec(asked);
    const file = /^(archive|file) thread (\S+)$/i.exec(asked);
    if (file && has('file_thread')) return { toolCalls: [{ name: 'file_thread', arguments: { id: file[2], box: file[1]!.toLowerCase() === 'archive' ? 'archived' : 'follow-up' } }] };
    if (send && has('send_email')) return { toolCalls: [{ name: 'send_email', arguments: { to: [send[1]], subject: 'A note from Timmy', body: send[2] } }] };
    if (/urgent/.test(text) && has('show_urgent')) return { content: 'Here is what needs you first.', toolCalls: [{ name: 'show_urgent', arguments: { limit: 5 } }] };
    if (/(mail|email|inbox|find|about|from)/.test(text) && has('search_mail')) return { toolCalls: [{ name: 'search_mail', arguments: { query: asked.replace(/[?.!]/g, '').split(/\s+/).slice(-3).join(' ') } }] };
    return { content: 'I’m not sure how to help with that yet.' };
  }
}

let provider: ModelProvider | null = null;

export const modelReady = () => config.fakeProviders || !!config.openrouter.apiKey;

function model(): ModelProvider {
  if (!provider) {
    if (config.fakeProviders) provider = new FakeModel();
    else if (config.openrouter.apiKey) provider = new OpenRouter();
    else throw new Error('No model is configured: set OPENROUTER_API_KEY');
  }
  return provider;
}

export function fakeModel(): FakeModel | null {
  const p = modelReady() ? model() : null;
  return p instanceof FakeModel ? p : null;
}
export function setModelForTests(p: ModelProvider | null) {
  provider = p;
}

/* ───────────── Spend ───────────── */

let serviceSpend = { at: 0, usd: 0 };

/** What every workspace together has spent on the model this month. Read at most every few seconds. */
async function serviceSpentThisMonth(): Promise<number> {
  if (Date.now() - serviceSpend.at > 5000) {
    const { rows } = await sysPool.query(`select coalesce(sum(cost_usd), 0)::float8 as usd from usage_event where at >= date_trunc('month', now())`);
    serviceSpend = { at: Date.now(), usd: Number(rows[0].usd) };
  }
  return serviceSpend.usd;
}
/** Tests change spend directly in the database; this makes the next check read it again. */
export const forgetServiceSpend = () => {
  serviceSpend = { at: 0, usd: 0 };
};

/**
 * Refuses a model call that would go past a spending limit. Three limits apply:
 * the workspace's own monthly limit; a smaller share of it for work nobody asked
 * for, so a flood of incoming mail can't use up what Ask and drafting need; and
 * one ceiling for the whole service, however many workspaces there are.
 *
 * The check comes before the call, so calls already in flight can take a
 * workspace a little past its limit: by at most what the jobs running at that
 * moment cost, and the number of those is capped too.
 */
export async function checkBudget(workspaceId: string, unattended = false): Promise<{ spent: number; cap: number }> {
  const row = await withWorkspace({ workspaceId }, async (tx) => {
    const w = (await tx.query('select monthly_spend_cap_usd from workspace where id = $1', [workspaceId])).rows[0];
    const s = (await tx.query(`select coalesce(sum(cost_usd), 0)::float8 as spent, coalesce(sum(cost_usd) filter (where unattended), 0)::float8 as alone from usage_event where workspace_id = $1 and at >= date_trunc('month', now())`, [workspaceId])).rows[0];
    return { cap: Number(w?.monthly_spend_cap_usd ?? 0), spent: Number(s.spent), alone: Number(s.alone) };
  });
  if (row.spent >= row.cap) throw new BudgetError(`This workspace has reached its monthly limit of $${row.cap.toFixed(2)} for Timmy’s model. An owner can raise it in Settings.`);
  if (unattended && row.alone >= row.cap * config.unattendedShare) throw new BudgetError('Timmy has used the part of this month’s limit set aside for reading mail on its own. Ask and drafting still work.');
  if ((await serviceSpentThisMonth()) >= config.serviceSpendCeilingUsd) throw new BudgetError('Timmy’s model is paused: the service has reached its spending limit for this month.');
  return row;
}

/** One model call: budget check, the call, and a cost record whether it worked or not. */
export async function complete(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResponse> {
  await checkBudget(req.workspaceId, req.unattended);
  const started = Date.now();
  let res: ModelResponse | null = null;
  try {
    res = await model().complete(req, onText);
    return res;
  } finally {
    const u = res?.usage;
    await withWorkspace({ workspaceId: req.workspaceId }, async (tx) => {
      await tx.query(
        `insert into usage_event (workspace_id, route, model, provider, run_id, tokens_in, tokens_out, tokens_reasoning, tokens_cached, tokens_cache_write, cost_usd, generation_id, ms, ok, unattended)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [req.workspaceId, req.route, res?.model ?? req.model, res?.provider ?? null, req.runId ?? null, u?.tokensIn ?? 0, u?.tokensOut ?? 0, u?.tokensReasoning ?? 0, u?.tokensCached ?? 0, u?.tokensCacheWrite ?? 0, u?.costUsd ?? 0, res?.id ?? null, Date.now() - started, !!res, !!req.unattended],
      );
      if (req.runId && u) await tx.query('update run set cost_usd = cost_usd + $2, tokens_in = tokens_in + $3, tokens_out = tokens_out + $4, tokens_reasoning = tokens_reasoning + $5 where id = $1', [req.runId, u.costUsd, u.tokensIn, u.tokensOut, u.tokensReasoning]);
    }).catch((e) => log.warn('could not record usage', { error: (e as Error).message }));
  }
}
