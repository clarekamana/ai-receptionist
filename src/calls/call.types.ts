/**
 * In-app (Mwakire mobile -> AI receptionist) call types. Kept separate from
 * the Twilio/telephony types (callSid.ts, telephony.controller.ts) — this
 * module's only job is call lifecycle + authorization; audio transport and
 * the AI itself live in AudioTransport/VoicePipeline, not here.
 */

export type CallState =
  | 'CREATED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ACTIVE'
  | 'ENDING'
  | 'ENDED'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_CALL_STATES: ReadonlySet<CallState> = new Set(['ENDED', 'FAILED', 'CANCELLED']);

/** The AppCall.id is also the LiveKit room name; this derives the
 * synthetic CallLog.callSid so the existing, unmodified telephony
 * persistence pipeline (and callSessionService's in-memory conversation
 * state) can be reused without either knowing app calls exist. Shared by
 * call.service.ts and call.gateway.ts — kept here (no dependencies) so
 * neither has to import the other just for this. */
export function toCallSid(callId: string): string {
  return `app_${callId}`;
}

export interface AppCallRecord {
  id: string;
  businessId: string;
  customerUserId: string | null;
  state: CallState;
  failureReason: string | null;
  startedAt: Date;
  connectedAt: Date | null;
  endedAt: Date | null;
}

/** Claims embedded in the short-lived, call-scoped bearer token minted at
 * call creation. Deliberately not a `User` JWT — the customer app has no
 * account system yet — but reuses the same signing mechanism/secret so a
 * future real customer-auth system can extend rather than replace this. */
export interface CallTokenClaims {
  callId: string;
  businessId: string;
  scope: 'app_call';
}
