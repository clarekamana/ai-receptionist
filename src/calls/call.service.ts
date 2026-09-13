import { prisma } from '../utils/db';
import { issueCallToken } from './call.auth';
import { createAppCall, getAppCall, transitionAppCall } from './call.session.service';
import { isLiveKitConfigured, createCustomerCallToken, startVoiceAgent, stopVoiceAgent } from './call.gateway';
import {
  getOrCreateSession,
  getTranscript,
  markCallCompleted,
  deleteSession,
} from '../services/callSessionService';
import { persistCallLog } from '../services/callLogPersistenceService';
import { AppCallRecord, CallState, toCallSid } from './call.types';

export interface CreatedCall {
  callId: string;
  callToken: string;
}

/**
 * Validates that a business can actually receive an app call — completed
 * onboarding is used as "this business's AI receptionist is configured",
 * deliberately NOT allocatedPhoneSid/allocatedPhone (that only reflects
 * whether a Twilio number was provisioned, which the in-app call path has
 * no need for at all).
 */
export async function createCall(businessId: string): Promise<CreatedCall> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, onboardingState: { select: { completed: true } } },
  });

  if (!business) {
    throw Object.assign(new Error('Business not found.'), { statusCode: 404 });
  }

  if (!business.onboardingState?.completed) {
    throw Object.assign(new Error("This business's AI receptionist isn't set up yet."), { statusCode: 409 });
  }

  const call = await createAppCall(businessId);
  const callToken = issueCallToken({ callId: call.id, businessId, scope: 'app_call' });

  return { callId: call.id, callToken };
}

export async function getCallStatus(callId: string): Promise<AppCallRecord | null> {
  return getAppCall(callId);
}

/**
 * Transitions CREATED -> CONNECTING, mints the LiveKit token the mobile
 * client needs to join the room, and starts the AI agent joining that same
 * room in the background. Returns null (never throws for this specific
 * case) when LiveKit isn't configured yet, so the controller can return a
 * clear "voice transport not configured" response instead of a generic
 * 500 — this is an expected, documented state during early development,
 * not a bug.
 *
 * CONNECTED/ACTIVE are NOT set here — they're driven by the agent actually
 * observing the customer join (see startVoiceAgent's onConnected hook
 * below), matching the target lifecycle: customer joins room -> AI agent
 * joins room -> CONNECTED -> ACTIVE.
 */
export async function beginConnecting(callId: string): Promise<{ url: string; token: string } | null> {
  if (!isLiveKitConfigured()) return null;

  const call = await getAppCall(callId);
  if (!call) throw Object.assign(new Error('Call not found.'), { statusCode: 404 });

  if (call.state === 'CREATED') {
    await transitionAppCall(callId, 'CONNECTING');
  }

  getOrCreateSession({ callSid: toCallSid(callId), businessId: call.businessId, customerPhone: `app:${callId}` });

  const transport = await createCustomerCallToken(callId, call.businessId);

  // Fire-and-forget: the mobile client doesn't wait on the agent to
  // receive its own token, and a failure here still needs the call marked
  // FAILED even though nothing is awaiting this promise.
  startVoiceAgent(callId, call.businessId, {
    onConnected: async () => {
      try {
        await transitionAppCall(callId, 'CONNECTED');
        await transitionAppCall(callId, 'ACTIVE');
      } catch (error) {
        // Most likely the call was already ended/failed by the time the
        // agent got here — never let a state-machine race crash the agent.
        console.warn('[app-calls] Could not transition call after agent connected.', {
          callId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onCustomerLeft: async () => {
      await endCall(callId).catch(() => undefined);
    },
    onFailure: async (reason) => {
      await markFailed(callId, reason);
    },
  }).catch((error) => {
    markFailed(callId, `AI agent failed to join: ${error instanceof Error ? error.message : String(error)}`).catch(
      () => undefined
    );
  });

  return transport;
}

export async function markFailed(callId: string, reason: string): Promise<void> {
  const call = await getAppCall(callId);
  if (!call) return;

  // FAILED is reachable from every non-terminal state (see call.state.ts);
  // swallow an already-terminal call rather than throwing during cleanup.
  try {
    await transitionAppCall(callId, 'FAILED', { failureReason: reason });
  } catch {
    return;
  }

  await finalizeCallLog(callId, call.businessId);
}

/**
 * User-initiated (or clean AI-initiated) call end. Always leaves the call
 * in a terminal state and always attempts to persist whatever transcript
 * exists, exactly mirroring the Twilio status-webhook's completion path —
 * see telephony.controller.ts's handleCallStatus for the equivalent.
 */
export async function endCall(callId: string): Promise<AppCallRecord> {
  const call = await getAppCall(callId);
  if (!call) throw Object.assign(new Error('Call not found.'), { statusCode: 404 });

  const nonTerminal: CallState[] = ['CREATED', 'CONNECTING', 'CONNECTED', 'ACTIVE'];
  if (nonTerminal.includes(call.state)) {
    if (call.state !== 'CREATED' && call.state !== 'CONNECTING') {
      await transitionAppCall(callId, 'ENDING');
      await transitionAppCall(callId, 'ENDED');
    } else {
      await transitionAppCall(callId, 'CANCELLED');
    }
  }

  await finalizeCallLog(callId, call.businessId);

  return (await getAppCall(callId)) as AppCallRecord;
}

// A client that crashes, loses network, or is force-quit mid-call can
// never call POST /:callId/end — without this sweep that AppCall row (and
// its in-memory callSessionService entry) would sit CONNECTING/ACTIVE
// forever: a zombie call. Mirrors callSessionService's own
// cleanupExpiredSessions() sweep for the same reason.
const STALE_CALL_MAX_AGE_MS = 60 * 60_000; // 1 hour
const NON_TERMINAL_STATES: CallState[] = ['CREATED', 'CONNECTING', 'CONNECTED', 'ACTIVE', 'ENDING'];

export async function sweepStaleAppCalls(now: Date = new Date()): Promise<number> {
  const stale = await prisma.appCall.findMany({
    where: {
      state: { in: NON_TERMINAL_STATES },
      startedAt: { lt: new Date(now.getTime() - STALE_CALL_MAX_AGE_MS) },
    },
    select: { id: true },
  });

  for (const call of stale) {
    await markFailed(call.id, 'Call abandoned — no client activity.');
  }

  if (stale.length > 0) {
    console.log('[app-calls] Maintenance sweep: marked stale calls as failed.', { count: stale.length });
  }

  return stale.length;
}

let appCallMaintenanceTimer: NodeJS.Timeout | null = null;

/** Safe to call more than once — only the first call has any effect. Uses
 * unref() so this interval alone never keeps the Node process alive. */
export function startAppCallMaintenanceSweep(intervalMs: number = 5 * 60_000): void {
  if (appCallMaintenanceTimer) return;

  appCallMaintenanceTimer = setInterval(() => {
    sweepStaleAppCalls().catch((error) => {
      console.error('[app-calls] Maintenance sweep failed.', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);

  appCallMaintenanceTimer.unref?.();
}

export function stopAppCallMaintenanceSweep(): void {
  if (appCallMaintenanceTimer) {
    clearInterval(appCallMaintenanceTimer);
    appCallMaintenanceTimer = null;
  }
}

async function finalizeCallLog(callId: string, businessId: string): Promise<void> {
  // Always attempt this, regardless of whether an agent was ever actually
  // running for this call — the common no-op case (LiveKit unconfigured,
  // agent never joined, call already cleaned up) is exactly why this is
  // safe to call unconditionally. This is what guarantees no zombie agent
  // participant survives a call ending, however it ended.
  await stopVoiceAgent(callId).catch((error) => {
    console.error('[app-calls] Failed to stop voice agent during cleanup.', {
      callId,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  const callSid = toCallSid(callId);
  const call = await getAppCall(callId);
  const durationSeconds = call?.startedAt
    ? Math.max(0, Math.floor((Date.now() - call.startedAt.getTime()) / 1000))
    : 0;

  const transcript = getTranscript(callSid);

  if (transcript) {
    // Same durable persistence path Twilio calls use — see
    // callLogPersistenceService.ts. Never throws; failures land in the
    // existing CallLogOutbox for retry. There's no real phone number for
    // an in-app call, but processAndSaveCallLog() finds/creates a Customer
    // by exact phone match — a shared placeholder like '' would silently
    // merge every anonymous app caller into one Customer row, so each call
    // gets its own unique, obviously-not-a-real-number placeholder instead.
    await persistCallLog({
      callSid,
      businessId,
      customerPhone: `app:${callId}`,
      transcript,
      durationSeconds,
    });
  }

  markCallCompleted(callSid);
  deleteSession(callSid);
}
