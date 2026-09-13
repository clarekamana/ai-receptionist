import { ChatMessage } from './aiCallService';
import { ENV } from '../config/env';

export interface CallSession {
  callSid: string;
  businessId: string;
  customerPhone: string;
  messages: ChatMessage[];
  transcript: string;
  startedAt: Date;
  lastActivityAt: Date;
  noInputAttempts: number;
}

/**
 * In-memory, single-process conversation state, keyed by Twilio CallSid.
 * Deliberately not Redis/a DB table — none of this is shared across
 * multiple backend instances, and all of it is lost on process restart
 * (durable call-log persistence is handled separately by
 * callLogPersistenceService.ts, which is unaffected by that restart).
 */
const sessions = new Map<string, CallSession>();

// Idempotency for call-completion processing, keyed by CallSid, valued by
// when it was marked complete. Kept separate from `sessions` so a duplicate
// "completed" status event is still recognized even after the session
// itself has been deleted. The timestamp lets cleanupCompletedCallSids()
// eventually forget it instead of growing forever.
const completedCallSids = new Map<string, Date>();

// Per-CallSid async serialization so two webhook deliveries for the same
// call can't interleave reads/writes of the same session while one of them
// is awaiting an external call (e.g. Groq). This only protects a single
// backend process/instance — it is not a distributed lock, and provides no
// protection if this service ever runs with more than one process/replica.
const callLocks = new Map<string, Promise<any>>();

export function withCallLock<T>(callSid: string, fn: () => Promise<T>): Promise<T> {
  const previous = callLocks.get(callSid) || Promise.resolve();
  const run = previous.then(fn, fn);

  const cleanup = run.then(
    () => undefined,
    () => undefined
  );
  callLocks.set(callSid, cleanup);
  cleanup.finally(() => {
    if (callLocks.get(callSid) === cleanup) {
      callLocks.delete(callSid);
    }
  });

  return run;
}

/** True while a CallSid has in-flight work under withCallLock. */
export function isCallLocked(callSid: string): boolean {
  return callLocks.has(callSid);
}

/**
 * Idempotent: returns the existing session for this CallSid if one already
 * exists (e.g. Twilio retried the initial webhook), otherwise creates one.
 */
export function getOrCreateSession(params: {
  callSid: string;
  businessId: string;
  customerPhone: string;
}): CallSession {
  const existing = sessions.get(params.callSid);
  if (existing) return existing;

  const now = new Date();
  const session: CallSession = {
    callSid: params.callSid,
    businessId: params.businessId,
    customerPhone: params.customerPhone,
    messages: [],
    transcript: '',
    startedAt: now,
    lastActivityAt: now,
    noInputAttempts: 0,
  };

  sessions.set(params.callSid, session);
  return session;
}

export function getSession(callSid: string): CallSession | undefined {
  return sessions.get(callSid);
}

export function appendUserMessage(callSid: string, content: string): void {
  const session = sessions.get(callSid);
  if (!session) return;

  session.messages.push({ role: 'user', content });
  session.transcript += `Caller: ${content}\n`;
  touchSession(callSid);
}

export function appendAssistantMessage(callSid: string, content: string): void {
  const session = sessions.get(callSid);
  if (!session) return;

  session.messages.push({ role: 'assistant', content });
  session.transcript += `Assistant: ${content}\n`;
  touchSession(callSid);
}

export function getMessages(callSid: string): ChatMessage[] {
  return sessions.get(callSid)?.messages ?? [];
}

export function getTranscript(callSid: string): string {
  return (sessions.get(callSid)?.transcript ?? '').trim();
}

export function touchSession(callSid: string): void {
  const session = sessions.get(callSid);
  if (session) session.lastActivityAt = new Date();
}

export function incrementNoInputAttempts(callSid: string): number {
  const session = sessions.get(callSid);
  if (!session) return 0;

  session.noInputAttempts += 1;
  touchSession(callSid);
  return session.noInputAttempts;
}

export function resetNoInputAttempts(callSid: string): void {
  const session = sessions.get(callSid);
  if (session) session.noInputAttempts = 0;
}

export function deleteSession(callSid: string): void {
  sessions.delete(callSid);
}

export function isCallCompleted(callSid: string): boolean {
  return completedCallSids.has(callSid);
}

/** Returns true if this call was newly marked, false if already completed. */
export function markCallCompleted(callSid: string): boolean {
  if (completedCallSids.has(callSid)) return false;
  completedCallSids.set(callSid, new Date());
  return true;
}

// --- Maintenance (Phase 4C) -------------------------------------------

const SESSION_MAX_INACTIVITY_MS = ENV.CALL_SESSION_TIMEOUT_MINUTES * 60_000;

// Long enough that any realistic duplicate "completed" status delivery from
// Twilio (which retries within minutes, not hours, if at all) is still
// caught by markCallCompleted()'s idempotency check; short enough that this
// map doesn't grow without bound in a long-running process.
const COMPLETED_CALL_RETENTION_MS = 6 * 60 * 60_000; // 6 hours

const MAINTENANCE_SWEEP_INTERVAL_MS = 60_000; // once per minute

/**
 * Removes sessions that have been idle longer than
 * ENV.CALL_SESSION_TIMEOUT_MINUTES. Never removes a session that currently
 * has in-flight work under withCallLock, even if it looks idle by
 * lastActivityAt (that field is only updated on append/touch, not while
 * merely awaiting Groq). Logs only CallSids and a count — never session
 * contents (messages/transcript).
 */
export function cleanupExpiredSessions(now: Date = new Date()): number {
  const threshold = now.getTime() - SESSION_MAX_INACTIVITY_MS;
  const removedCallSids: string[] = [];

  for (const [callSid, session] of sessions) {
    if (isCallLocked(callSid)) continue;
    if (session.lastActivityAt.getTime() < threshold) {
      sessions.delete(callSid);
      removedCallSids.push(callSid);
    }
  }

  if (removedCallSids.length > 0) {
    console.log('[telephony] Session maintenance: removed expired sessions.', {
      removed: removedCallSids.length,
      callSids: removedCallSids,
    });
  }

  return removedCallSids.length;
}

/** Prunes completed-call idempotency records older than the retention window. */
export function cleanupCompletedCallSids(now: Date = new Date()): number {
  const threshold = now.getTime() - COMPLETED_CALL_RETENTION_MS;
  let removed = 0;

  for (const [callSid, completedAt] of completedCallSids) {
    if (completedAt.getTime() < threshold) {
      completedCallSids.delete(callSid);
      removed += 1;
    }
  }

  if (removed > 0) {
    console.log('[telephony] Session maintenance: pruned old completed-call records.', { removed });
  }

  return removed;
}

export function runMaintenanceSweep(now: Date = new Date()): {
  expiredSessions: number;
  prunedCompletedCallSids: number;
} {
  return {
    expiredSessions: cleanupExpiredSessions(now),
    prunedCompletedCallSids: cleanupCompletedCallSids(now),
  };
}

let maintenanceTimer: NodeJS.Timeout | null = null;

/**
 * Starts the periodic maintenance sweep exactly once per process. Safe to
 * call more than once (e.g. an accidental duplicate import) — only the
 * first call has any effect. Uses unref() so this interval alone never
 * keeps the Node process alive (e.g. during a graceful shutdown).
 */
export function startSessionMaintenanceSweep(intervalMs: number = MAINTENANCE_SWEEP_INTERVAL_MS): void {
  if (maintenanceTimer) return;

  maintenanceTimer = setInterval(() => {
    try {
      runMaintenanceSweep();
    } catch (error) {
      console.error('[telephony] Session maintenance sweep failed.', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalMs);

  maintenanceTimer.unref?.();
}

/** Test-only escape hatch; also usable for a clean process shutdown. */
export function stopSessionMaintenanceSweep(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}
