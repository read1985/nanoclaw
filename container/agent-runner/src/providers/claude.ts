import fs from 'fs';
import path from 'path';

import {
  query as sdkQuery,
  type HookCallback,
  type PreCompactHookInput,
  type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

// ── Budget caps (ported from v1 container/agent-runner/src/index.ts) ──
// Per-USER-MESSAGE caps. Budget state is created fresh per query() call and
// reset on each push() from the host so a chatty conversation never inherits
// the previous turn's budget.
const SOFT_CAP_TURNS = 60;
const HARD_CAP_TURNS = 75;
const SOFT_CAP_MS = 6 * 60_000;
const HARD_CAP_MS = 8 * 60_000;

// ── Per-tool-call approval gate (ported from v1) ──
// Matching tool calls are paused by the PreToolUse hook, which writes a
// request JSON to /workspace/ipc/approvals/ and waits for a response JSON
// from the host. Budget timer is rewound by the wait duration so user
// think-time doesn't consume the agent's budget.
interface ApprovalPattern {
  tool: string;
  match: (toolInput: Record<string, unknown>) => string | null;
}
const APPROVAL_PATTERNS: ApprovalPattern[] = [
  {
    tool: 'Bash',
    match: (i) => {
      const cmd = typeof i.command === 'string' ? i.command : '';
      if (/\b(gmail|gcal|gdocs)\.py\b.*\b(send|reply|forward|trash|delete|move|untrash)\b/.test(cmd)) {
        return 'Gmail/Calendar/Docs mutation';
      }
      if (/\bdropbox\.py\b.*\b(delete|move|share)\b/.test(cmd)) {
        return 'Dropbox mutation';
      }
      if (/\bnotion\.py\b.*\b(delete|archive)\b/.test(cmd)) {
        return 'Notion destructive';
      }
      if (/\b(p3|python3?)\s+\S*portal_login\.py\b/.test(cmd)) {
        return 'Portal login (vault credential use)';
      }
      return null;
    },
  },
];
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_IPC_DIR = '/workspace/ipc/approvals';

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Mutable budget state shared between the event translator and the hooks.
 * Created fresh per query() call; reset to zero on each push() from the host.
 */
interface BudgetState {
  startTime: number;
  turnCounter: number;
  hardCapHit: boolean;
  approvalInFlight: boolean;
}

/**
 * Soft-warns at 6min / 60 turns then hard-denies every subsequent tool call
 * at 8min / 75 turns. Forces the agent to either reply or fail rather than
 * grind silently.
 */
function createBudgetHook(budget: BudgetState): HookCallback {
  return async (input) => {
    const ptu = input as PreToolUseHookInput;
    // While approval hook is awaiting a user tap, don't count wall-clock
    // against the budget — the approval hook shifts startTime forward when
    // it resolves, but we short-circuit here to guarantee we don't trip
    // hard-cap mid-wait.
    if (budget.approvalInFlight) return { continue: true };

    const elapsedMs = Date.now() - budget.startTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    const turn = budget.turnCounter;

    if (elapsedMs > HARD_CAP_MS || turn >= HARD_CAP_TURNS || budget.hardCapHit) {
      budget.hardCapHit = true;
      log(`Budget HARD cap (elapsed=${elapsedSec}s turn=${turn} tool=${ptu.tool_name}) — denying`);
      return {
        decision: 'block',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `BUDGET_EXHAUSTED: ${elapsedSec}s elapsed, ${turn} agent turns used. ` +
            `Stop calling tools immediately. Reply to the user with: ` +
            `(1) results so far, (2) what is still incomplete, ` +
            `(3) a question asking which slice to handle next turn. ` +
            `Every further tool call will be denied with this same message.`,
        },
      } as unknown as ReturnType<HookCallback>;
    }

    if (elapsedMs > SOFT_CAP_MS || turn >= SOFT_CAP_TURNS) {
      log(`Budget SOFT cap (elapsed=${elapsedSec}s turn=${turn} tool=${ptu.tool_name})`);
      return {
        decision: 'approve',
        systemMessage:
          `⏱️ BUDGET WARNING: ${elapsedSec}s elapsed and ${turn} turns used. ` +
          `You have less than 2 minutes / 15 turns before hard cap. ` +
          `After this tool call, stop and reply with: ` +
          `(1) what you found, (2) what is still pending, ` +
          `(3) ask the user which slice to do next. Do NOT keep calling tools.`,
      } as unknown as ReturnType<HookCallback>;
    }

    return { continue: true };
  };
}

/**
 * Poll /workspace/ipc/approvals/resp-{reqId}.json until it appears or timeout.
 */
function waitForApprovalFile(
  respPath: string,
  timeoutMs: number,
  pollMs: number,
): Promise<{ approved: boolean; reason?: string; decidedBy?: string } | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (fs.existsSync(respPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
          resolve({
            approved: !!data.approved,
            reason: typeof data.reason === 'string' ? data.reason : undefined,
            decidedBy: typeof data.decidedBy === 'string' ? data.decidedBy : undefined,
          });
          return;
        } catch (err) {
          log(`Failed to parse approval response ${respPath}: ${err instanceof Error ? err.message : String(err)}`);
          resolve(null);
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

/**
 * For tool calls that match APPROVAL_PATTERNS, writes an approval request to
 * IPC and blocks until a response is written. Rewinds the budget timer by the
 * wait duration so user think-time doesn't consume the agent's budget.
 */
function createApprovalHook(budget: BudgetState): HookCallback {
  return async (input, toolUseId) => {
    const ptu = input as PreToolUseHookInput;
    const toolName = ptu.tool_name;
    const toolInput = (ptu.tool_input ?? {}) as Record<string, unknown>;

    let reason: string | null = null;
    for (const pat of APPROVAL_PATTERNS) {
      if (pat.tool !== toolName) continue;
      const r = pat.match(toolInput);
      if (r) {
        reason = r;
        break;
      }
    }
    if (!reason) return { continue: true };

    const preview =
      toolName === 'Bash' && typeof toolInput.command === 'string'
        ? (toolInput.command as string).slice(0, 1500)
        : JSON.stringify(toolInput).slice(0, 1500);

    const reqId = `${Date.now()}-${toolUseId || Math.random().toString(36).slice(2, 10)}`;
    const reqPath = `${APPROVAL_IPC_DIR}/req-${reqId}.json`;
    const respPath = `${APPROVAL_IPC_DIR}/resp-${reqId}.json`;
    try {
      fs.mkdirSync(APPROVAL_IPC_DIR, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      fs.writeFileSync(
        reqPath,
        JSON.stringify({
          reqId,
          toolName,
          toolInput,
          preview,
          reason,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      log(`Failed to write approval request ${reqPath}: ${err instanceof Error ? err.message : String(err)} — failing closed (deny)`);
      return {
        decision: 'block',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Internal error: could not post approval request. Tool call blocked.',
        },
      } as unknown as ReturnType<HookCallback>;
    }

    log(`Approval requested: ${reason} (reqId=${reqId})`);
    const pauseStart = Date.now();
    budget.approvalInFlight = true;
    const resp = await waitForApprovalFile(respPath, APPROVAL_TIMEOUT_MS, APPROVAL_POLL_INTERVAL_MS);
    const waitedMs = Date.now() - pauseStart;

    // Don't count approval-wait against budget
    budget.startTime += waitedMs;
    budget.approvalInFlight = false;

    log(`Approval ${resp?.approved ? 'granted' : resp ? 'denied' : 'timed out'} after ${Math.round(waitedMs / 1000)}s (reqId=${reqId})`);

    try {
      if (fs.existsSync(reqPath)) fs.unlinkSync(reqPath);
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(respPath)) fs.unlinkSync(respPath);
    } catch {
      /* ignore */
    }

    if (resp?.approved) return { continue: true };

    const denyReason = resp
      ? `User denied approval${resp.reason ? `: ${resp.reason}` : ''}.`
      : `User approval timed out after ${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} min — treating as denied.`;

    return {
      decision: 'block',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${denyReason} Do NOT retry this exact action. Reply to the user ` +
          `explaining what you wanted to do and ask for direction on how to proceed.`,
      },
    } as unknown as ReturnType<HookCallback>;
  };
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    // Per-query budget state. Reset on each host push() so each new user
    // message starts fresh.
    const budget: BudgetState = {
      startTime: Date.now(),
      turnCounter: 0,
      hardCapHit: false,
      approvalInFlight: false,
    };

    const instructions = input.systemContext?.instructions;

    // Cron-initiated batches skip the per-tool-call approval gate. The
    // schedule itself is the authorisation event — there's no human in the
    // loop to tap a Discord card, and without this every scheduled task
    // that touches an APPROVAL_PATTERNS-matched tool (gmail send, dropbox
    // delete, portal_login, …) times out after 5 min and the cron run
    // fails. Budget caps still apply. The flag is set by poll-loop.ts when
    // any message in the batch is kind='task'.
    const skipApprovalGate = input.fromScheduledTask === true;
    if (skipApprovalGate) {
      log('Approval gate bypassed for this query (fromScheduledTask=true)');
    }
    const preToolUseHooks = [
      { hooks: [preToolUseHook] },
      ...(skipApprovalGate ? [] : [{ hooks: [createApprovalHook(budget)] }]),
      { hooks: [createBudgetHook(budget)] },
    ];

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        allowedTools: TOOL_ALLOWLIST,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: preToolUseHooks,
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Increment agent turn counter for budget cap tracking.
        if (message.type === 'assistant') {
          budget.turnCounter++;
        }

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
          yield { type: 'result', text };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'result', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages (budget: ${budget.turnCounter} turns / ${Math.round((Date.now() - budget.startTime) / 1000)}s, hardCap=${budget.hardCapHit})`);
    }

    return {
      push: (msg) => {
        // Host is pushing a new user message — reset the per-message budget.
        log(`Resetting budget for new user turn (previous: ${budget.turnCounter} turns / ${Math.round((Date.now() - budget.startTime) / 1000)}s)`);
        budget.startTime = Date.now();
        budget.turnCounter = 0;
        budget.hardCapHit = false;
        stream.push(msg);
      },
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
