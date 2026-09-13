import { Response } from 'express';
import { Request } from 'express';
import { createCall, getCallStatus, beginConnecting, endCall, markFailed } from './call.service';
import { CallAuthedRequest } from './call.auth';
import { AppCallRecord } from './call.types';

function serializeCall(call: AppCallRecord) {
  return {
    callId: call.id,
    businessId: call.businessId,
    state: call.state,
    failureReason: call.failureReason,
    startedAt: call.startedAt.toISOString(),
    connectedAt: call.connectedAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
  };
}

function handleError(res: Response, error: unknown) {
  const statusCode = (error as any)?.statusCode;
  if (typeof statusCode === 'number') {
    return res.status(statusCode).json({ error: (error as Error).message });
  }

  console.error('[app-calls] Unhandled error.', {
    message: error instanceof Error ? error.message : String(error),
  });
  return res.status(500).json({ error: 'Something went wrong starting this call.' });
}

/**
 * POST /api/app-calls — public (no account system exists for the Mwakire
 * customer app yet). Anyone can request to call a business's AI
 * receptionist, exactly like anyone can dial a published phone number
 * today; what this endpoint hands back (a call-scoped token) is what gates
 * every subsequent action on this specific call.
 */
export async function createAppCallHandler(req: Request, res: Response) {
  const businessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : '';
  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required.' });
  }

  try {
    const { callId, callToken } = await createCall(businessId);
    return res.status(201).json({ callId, callToken });
  } catch (error) {
    return handleError(res, error);
  }
}

export async function getAppCallHandler(req: CallAuthedRequest, res: Response) {
  try {
    const call = await getCallStatus(req.params.callId);
    if (!call) return res.status(404).json({ error: 'Call not found.' });
    return res.json(serializeCall(call));
  } catch (error) {
    return handleError(res, error);
  }
}

/**
 * POST /api/app-calls/:callId/connect — mints the LiveKit room token. A 503
 * here means "LiveKit isn't configured on this backend yet," which is an
 * expected state during early development (see call.gateway.ts), not a
 * server error — the mobile client is expected to show a clean failure
 * state for it (per the failure-handling requirements) rather than crash.
 */
export async function connectAppCallHandler(req: CallAuthedRequest, res: Response) {
  try {
    const transport = await beginConnecting(req.params.callId);
    if (!transport) {
      return res.status(503).json({ error: 'Voice calling is not available yet. Please try again later.' });
    }
    return res.json(transport);
  } catch (error) {
    return handleError(res, error);
  }
}

export async function endAppCallHandler(req: CallAuthedRequest, res: Response) {
  try {
    const call = await endCall(req.params.callId);
    return res.json(serializeCall(call));
  } catch (error) {
    return handleError(res, error);
  }
}

export async function failAppCallHandler(req: CallAuthedRequest, res: Response) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'Client-reported failure.';
  try {
    await markFailed(req.params.callId, reason);
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
}
