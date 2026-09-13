import { prisma } from '../utils/db';
import { processAndSaveCallLog, PostCallAnalysis } from './aiCallService';
import { sendEscalationNotice } from './emailService';

export interface CallLogInput {
  callSid: string;
  businessId: string;
  customerPhone: string;
  transcript: string;
  durationSeconds: number;
}

// Bounded exponential backoff: 1m, 2m, 4m, 8m, 16m (capped), stopping after
// OUTBOX_MAX_ATTEMPTS. This is a single-process sweep, not a distributed
// queue — running more than one backend instance would mean each instance
// independently polls and could double-process a row; see the module-level
// note below.
const OUTBOX_BASE_RETRY_DELAY_MS = 60_000;
const OUTBOX_MAX_RETRY_DELAY_MS = 30 * 60_000;
const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_SWEEP_INTERVAL_MS = 60_000;

export function backoffDelayMs(attempts: number): number {
  const delay = OUTBOX_BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(delay, OUTBOX_MAX_RETRY_DELAY_MS);
}

/** Truncates and strips an error down to a safe, storable summary. */
function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

/**
 * Persists a completed call's log, durably. This is the only place that
 * calls processAndSaveCallLog() from the telephony layer — aiCallService.ts
 * itself is untouched and has no knowledge of CallSid/outbox/retries.
 *
 * On success, stamps CallSid onto the created CallLog row (a follow-up
 * update, not part of processAndSaveCallLog()) so later code — including
 * the retry sweep below — can tell "has this call already been logged"
 * without needing aiCallService.ts to know about telephony at all.
 *
 * On failure, writes/updates a CallLogOutbox row instead of losing the
 * transcript. Never throws — the caller (the /status webhook) must always
 * be able to return 200 to Twilio regardless of outcome.
 */
export async function persistCallLog(input: CallLogInput): Promise<{ persisted: boolean }> {
  const existingLog = await prisma.callLog.findUnique({ where: { callSid: input.callSid } }).catch(() => null);
  if (existingLog) {
    // Already logged (e.g. a prior attempt succeeded but this function was
    // somehow invoked again) — never create a duplicate.
    await clearOutboxIfPresent(input.callSid);
    return { persisted: true };
  }

  try {
    const { callLog, analysis } = await processAndSaveCallLog({
      businessId: input.businessId,
      customerPhone: input.customerPhone,
      transcript: input.transcript,
      durationSeconds: input.durationSeconds,
    });

    await prisma.callLog.update({ where: { id: callLog.id }, data: { callSid: input.callSid } });
    await clearOutboxIfPresent(input.callSid);
    await applyEscalationOutcome(callLog.id, input.businessId, input.customerPhone, analysis);

    return { persisted: true };
  } catch (error) {
    console.error('[telephony] processAndSaveCallLog FAILED — writing to durable outbox instead.', {
      callSid: input.callSid,
      businessId: input.businessId,
      errorCategory: error instanceof Error ? error.name || 'Error' : 'UnknownError',
    });

    await prisma.callLogOutbox.upsert({
      where: { callSid: input.callSid },
      create: {
        callSid: input.callSid,
        businessId: input.businessId,
        customerPhone: input.customerPhone,
        transcript: input.transcript,
        durationSeconds: input.durationSeconds,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + OUTBOX_BASE_RETRY_DELAY_MS),
        lastError: safeErrorMessage(error),
      },
      update: {
        // Refresh the payload in case this is a genuinely new failed
        // attempt for the same call rather than a stale row.
        transcript: input.transcript,
        durationSeconds: input.durationSeconds,
        lastError: safeErrorMessage(error),
      },
    });

    return { persisted: false };
  }
}

async function clearOutboxIfPresent(callSid: string): Promise<void> {
  await prisma.callLogOutbox
    .updateMany({ where: { callSid, status: 'PENDING' }, data: { status: 'COMPLETED' } })
    .catch(() => undefined);
}

/**
 * Turns the existing Groq post-call analysis (already computed by
 * processAndSaveCallLog — no new AI call here) into a persisted escalation
 * record and, where SMTP is configured, an owner notification. Runs after
 * the CallLog row already exists, from both the live-completion path and a
 * later successful outbox retry, so escalation is captured exactly once no
 * matter which path actually persisted the call.
 */
async function applyEscalationOutcome(
  callLogId: string,
  businessId: string,
  callerPhone: string,
  analysis: PostCallAnalysis
): Promise<void> {
  const needsEscalation = analysis.outcomeTag === 'ESCALATED';
  if (!needsEscalation) return;

  const reason =
    (analysis.unansweredQuestions && analysis.unansweredQuestions[0]) ||
    analysis.summary ||
    'The AI flagged this call as needing owner follow-up.';

  await prisma.callLog.update({
    where: { id: callLogId },
    data: { needsEscalation: true, escalationReason: reason, escalationStatus: 'PENDING' },
  });

  const business = await prisma.business
    .findUnique({ where: { id: businessId }, select: { name: true, owner: { select: { email: true } } } })
    .catch(() => null);

  if (!business?.owner?.email) return;

  await sendEscalationNotice(business.owner.email, {
    businessName: business.name,
    callerPhone,
    reason,
    occurredAt: new Date(),
  }).catch((error) => {
    // A failed notification must never affect call persistence — the
    // escalation is already durably recorded on the CallLog row above and
    // remains visible in the dashboard either way.
    console.error('[telephony] Escalation notification failed to send.', {
      businessId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export interface OutboxSweepResult {
  attempted: number;
  succeeded: number;
  failed: number;
  exhausted: number;
}

/**
 * Processes due CallLogOutbox rows sequentially (deliberately not in
 * parallel — this keeps the sweep simple and avoids any need for per-row
 * locking within this single process). Not safe to run as multiple
 * concurrent processes/replicas: each would independently claim the same
 * due rows with no coordination between them. That is an explicit MVP
 * limitation, not a distributed queue.
 */
export async function runOutboxRetrySweep(now: Date = new Date()): Promise<OutboxSweepResult> {
  const result: OutboxSweepResult = { attempted: 0, succeeded: 0, failed: 0, exhausted: 0 };

  const due = await prisma.callLogOutbox.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
  });

  for (const row of due) {
    result.attempted += 1;

    const existingLog = await prisma.callLog.findUnique({ where: { callSid: row.callSid } }).catch(() => null);
    if (existingLog) {
      // Already logged by some other path — never re-run processAndSaveCallLog for it.
      await prisma.callLogOutbox.update({ where: { id: row.id }, data: { status: 'COMPLETED' } });
      result.succeeded += 1;
      continue;
    }

    try {
      const { callLog, analysis } = await processAndSaveCallLog({
        businessId: row.businessId,
        customerPhone: row.customerPhone,
        transcript: row.transcript,
        durationSeconds: row.durationSeconds,
      });

      await prisma.callLog.update({ where: { id: callLog.id }, data: { callSid: row.callSid } });
      await prisma.callLogOutbox.update({ where: { id: row.id }, data: { status: 'COMPLETED' } });
      await applyEscalationOutcome(callLog.id, row.businessId, row.customerPhone, analysis);

      result.succeeded += 1;
      console.log('[telephony] Outbox retry succeeded.', { callSid: row.callSid, attempts: row.attempts + 1 });
    } catch (error) {
      const attempts = row.attempts + 1;

      if (attempts >= row.maxAttempts) {
        await prisma.callLogOutbox.update({
          where: { id: row.id },
          data: { attempts, status: 'FAILED', lastError: safeErrorMessage(error) },
        });
        result.exhausted += 1;
        console.error('[telephony] Outbox retry exhausted max attempts — giving up.', {
          callSid: row.callSid,
          attempts,
          maxAttempts: row.maxAttempts,
        });
      } else {
        await prisma.callLogOutbox.update({
          where: { id: row.id },
          data: {
            attempts,
            nextAttemptAt: new Date(now.getTime() + backoffDelayMs(attempts)),
            lastError: safeErrorMessage(error),
          },
        });
        result.failed += 1;
        console.warn('[telephony] Outbox retry failed; scheduled another attempt.', {
          callSid: row.callSid,
          attempts,
        });
      }
    }
  }

  return result;
}

let outboxTimer: NodeJS.Timeout | null = null;

/**
 * Starts the periodic outbox retry sweep exactly once per process. Safe to
 * call more than once — only the first call has any effect. Uses unref()
 * so this interval alone never keeps the Node process alive.
 */
export function startOutboxRetryLoop(intervalMs: number = OUTBOX_SWEEP_INTERVAL_MS): void {
  if (outboxTimer) return;

  outboxTimer = setInterval(() => {
    runOutboxRetrySweep().catch((error) => {
      console.error('[telephony] Outbox retry sweep failed.', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);

  outboxTimer.unref?.();
}

/** Test-only escape hatch; also usable for a clean process shutdown. */
export function stopOutboxRetryLoop(): void {
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
}
