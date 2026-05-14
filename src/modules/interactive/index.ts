/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the button-click response: look up the pending_questions
 * row, write the response into the session's inbound.db, wake the container.
 *
 * The `createPendingQuestion` call in `deliverMessage` (delivery.ts) stays
 * inline in core — it's 15 lines guarded by `hasTable('pending_questions')`,
 * modularizing it adds more registry surface than it saves.
 */
import fs from 'fs';
import path from 'path';

import { getDb, hasTable } from '../../db/connection.js';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { sessionsBaseDir, writeSessionMessage } from '../../session-manager.js';

// ── Preauth-token bridge to approval-gate ──
// A positive option click on an ask_user_question card writes a single-use
// `.preauth.json` token into the same session's approvals IPC dir. The
// approval-gate watcher consumes it (within PREAUTH_TTL_MS) to skip the
// per-tool-call Discord card — so the user isn't asked twice for the same
// logical action (e.g. ask_user_question "Send reply?" then gmail.py reply).
const PREAUTH_POSITIVE_RE = /^(send|confirm|approve|yes|ok(?:ay)?|go|proceed|do it|sure|looks good)\b/i;
const PREAUTH_TTL_MS = 30_000;

function maybeWritePreauth(
  agentGroupId: string,
  sessionId: string,
  value: string | undefined,
  questionId: string,
): void {
  const v = (value ?? '').trim();
  if (!v || !PREAUTH_POSITIVE_RE.test(v)) return;
  const dir = path.join(sessionsBaseDir(), agentGroupId, sessionId, 'ipc', 'approvals');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.preauth.json'),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        ttlMs: PREAUTH_TTL_MS,
        questionId,
        selectedValue: v,
      }),
    );
    log.info('Preauth token written', { agentGroupId, sessionId, questionId, value: v });
  } catch (err) {
    log.error('Failed to write preauth token', { err, agentGroupId, sessionId });
  }
}

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'pending_questions')) return false;

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return false;

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
    deletePendingQuestion(payload.questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: payload.questionId,
      selectedOption: payload.value,
      userId: payload.userId ?? '',
    }),
  });

  deletePendingQuestion(payload.questionId);
  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
  });

  maybeWritePreauth(session.agent_group_id, session.id, payload.value, payload.questionId);

  await wakeContainer(session);
  return true;
}

registerResponseHandler(handleInteractiveResponse);
