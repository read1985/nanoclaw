/**
 * Approval-gate module — bridges the container-side per-tool-call approval hook
 * to v2's approvals primitive.
 *
 * The container agent-runner (providers/claude.ts) writes `req-{reqId}.json`
 * files to `/workspace/ipc/approvals/` on matching tool calls (Bash gmail/gcal/
 * gdocs mutation, dropbox delete/move/share, notion delete/archive) and polls
 * for `resp-{reqId}.json`. This module:
 *
 *   1. Registers a `'bash-sensitive'` approval handler with the approvals
 *      primitive. On approve, writes `resp-{reqId}.json` back so the
 *      container-side poll unblocks.
 *   2. Starts a filesystem watcher that scans every session's IPC dir for
 *      new req files and calls `requestApproval()` — v2's primitive picks
 *      an approver, delivers a chat-sdk `ask_question` card to the admin DM,
 *      and records the pending_approvals row.
 *
 * On reject, v2's response handler notifies the agent and drops the row
 * WITHOUT calling our handler — so the container-side poll won't see a
 * resp file and will time out to deny after 5 min. This is safe (fails
 * closed) but slow. Improving the reject latency would require passing
 * rejects into the handler; deferred.
 */
import fs from 'fs';
import path from 'path';

import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';

const POLL_MS = 500;
const APPROVAL_ACTION = 'bash-sensitive';

interface ApprovalReq {
  reqId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  preview: string;
  reason: string;
  createdAt: string;
}

interface ApprovalGatePayload {
  reqId: string;
  sessionId: string;
  agentGroupId: string;
}

function approvalsDirFor(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId, 'ipc', 'approvals');
}

// Writes the resp file that the container agent-runner polls. Fires on both
// approve and reject paths (see src/modules/approvals/response-handler.ts).
// Writing the reject resp file lets the waiter unblock immediately instead of
// hitting the 5-minute poll timeout.
registerApprovalHandler(APPROVAL_ACTION, async (ctx) => {
  const payload = ctx.payload as unknown as ApprovalGatePayload;
  const respPath = path.join(approvalsDirFor(payload.agentGroupId, payload.sessionId), `resp-${payload.reqId}.json`);
  try {
    fs.mkdirSync(path.dirname(respPath), { recursive: true });
    fs.writeFileSync(
      respPath,
      JSON.stringify({
        reqId: payload.reqId,
        approved: ctx.approved,
        decidedBy: ctx.userId,
        decidedAt: new Date().toISOString(),
      }),
    );
    log.info('Approval-gate: wrote resp file', { reqId: payload.reqId, approved: ctx.approved });
  } catch (err) {
    log.error('Approval-gate: failed to write resp file', { err, reqId: payload.reqId });
    ctx.notify(`Approval for ${payload.reqId} could not be applied: file write failed.`);
  }
});

const dispatched = new Set<string>();

function listSessions(): Array<{ agentGroupId: string; sessionId: string }> {
  const base = sessionsBaseDir();
  if (!fs.existsSync(base)) return [];
  const sessions: Array<{ agentGroupId: string; sessionId: string }> = [];
  try {
    for (const agentGroupId of fs.readdirSync(base)) {
      const agentDir = path.join(base, agentGroupId);
      try {
        if (!fs.statSync(agentDir).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        for (const sessionId of fs.readdirSync(agentDir)) {
          const sessDir = path.join(agentDir, sessionId);
          try {
            if (fs.statSync(sessDir).isDirectory()) {
              sessions.push({ agentGroupId, sessionId });
            }
          } catch {
            /* ignore races */
          }
        }
      } catch {
        /* ignore races */
      }
    }
  } catch (err) {
    log.error('Approval-gate: error walking sessions', { err });
  }
  return sessions;
}

async function tick(): Promise<void> {
  try {
    const allSessions = listSessions();
    const liveIds = new Set<string>();
    for (const { agentGroupId, sessionId } of allSessions) {
      const approvalsDir = approvalsDirFor(agentGroupId, sessionId);
      if (!fs.existsSync(approvalsDir)) continue;
      try {
        for (const f of fs.readdirSync(approvalsDir)) {
          if (f.startsWith('req-') && f.endsWith('.json')) {
            liveIds.add(f.slice('req-'.length, -'.json'.length));
          }
        }
      } catch {
        /* ignore — handled per-session below */
      }
    }
    for (const id of dispatched) {
      if (!liveIds.has(id)) dispatched.delete(id);
    }

    for (const { agentGroupId, sessionId } of allSessions) {
      const approvalsDir = approvalsDirFor(agentGroupId, sessionId);
      if (!fs.existsSync(approvalsDir)) continue;

      let reqFiles: string[];
      try {
        reqFiles = fs.readdirSync(approvalsDir).filter((f) => f.startsWith('req-') && f.endsWith('.json'));
      } catch (err) {
        log.error('Approval-gate: error reading approvals dir', { err, approvalsDir });
        continue;
      }

      for (const file of reqFiles) {
        const reqId = file.slice('req-'.length, -'.json'.length);
        if (dispatched.has(reqId)) continue;

        const reqPath = path.join(approvalsDir, file);
        let req: ApprovalReq;
        try {
          req = JSON.parse(fs.readFileSync(reqPath, 'utf-8'));
        } catch (err) {
          log.error('Approval-gate: failed to parse req file', { err, file });
          dispatched.add(reqId);
          continue;
        }

        const session = getSession(sessionId);
        if (!session) {
          log.warn('Approval-gate: no session for req', { sessionId, reqId });
          dispatched.add(reqId);
          continue;
        }

        dispatched.add(reqId);
        try {
          const preview = req.preview.slice(0, 1500);
          await requestApproval({
            session,
            agentName: 'agent',
            action: APPROVAL_ACTION,
            payload: { reqId, sessionId, agentGroupId } satisfies ApprovalGatePayload,
            title: `Approval required: ${req.reason}`,
            question: `**Tool:** \`${req.toolName}\`\n\n\`\`\`\n${preview}\n\`\`\``,
          });
          log.info('Approval-gate: dispatched request', { reqId, reason: req.reason, sessionId });
        } catch (err) {
          log.error('Approval-gate: failed to dispatch', { err, reqId, sessionId });
        }
      }
    }
  } catch (err) {
    log.error('Approval-gate: tick error', { err });
  }
  setTimeout(() => {
    void tick();
  }, POLL_MS);
}

export function startApprovalGate(): void {
  log.info('Approval-gate watcher started');
  void tick();
}

startApprovalGate();
