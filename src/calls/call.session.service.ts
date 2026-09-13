import { prisma } from '../utils/db';
import { AppCallRecord, CallState } from './call.types';
import { assertTransition } from './call.state';

/**
 * Durable CRUD + state-transition enforcement for one AppCall row. Separate
 * from callSessionService.ts on purpose: that module holds the in-memory
 * conversation (messages/transcript), transport-agnostic and reused as-is
 * from the Twilio path; this module holds the durable lifecycle/ownership
 * record a REST client can query and that survives a backend restart.
 */

function toRecord(row: {
  id: string;
  businessId: string;
  customerUserId: string | null;
  state: string;
  failureReason: string | null;
  startedAt: Date;
  connectedAt: Date | null;
  endedAt: Date | null;
}): AppCallRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    customerUserId: row.customerUserId,
    state: row.state as CallState,
    failureReason: row.failureReason,
    startedAt: row.startedAt,
    connectedAt: row.connectedAt,
    endedAt: row.endedAt,
  };
}

export async function createAppCall(businessId: string): Promise<AppCallRecord> {
  const row = await prisma.appCall.create({ data: { businessId, state: 'CREATED' } });
  return toRecord(row);
}

export async function getAppCall(callId: string): Promise<AppCallRecord | null> {
  const row = await prisma.appCall.findUnique({ where: { id: callId } });
  return row ? toRecord(row) : null;
}

/**
 * Validates the transition via call.state.ts before writing — a caller
 * cannot skip validation by calling prisma directly, because this is the
 * only place in the codebase allowed to write AppCall.state.
 */
export async function transitionAppCall(
  callId: string,
  to: CallState,
  extra: { failureReason?: string } = {}
): Promise<AppCallRecord> {
  const current = await prisma.appCall.findUnique({ where: { id: callId } });
  if (!current) throw new Error(`AppCall ${callId} not found.`);

  assertTransition(current.state as CallState, to);

  const now = new Date();
  const row = await prisma.appCall.update({
    where: { id: callId },
    data: {
      state: to,
      failureReason: extra.failureReason ?? current.failureReason,
      connectedAt: to === 'CONNECTED' ? now : current.connectedAt,
      endedAt: to === 'ENDED' || to === 'FAILED' || to === 'CANCELLED' ? now : current.endedAt,
    },
  });

  return toRecord(row);
}
