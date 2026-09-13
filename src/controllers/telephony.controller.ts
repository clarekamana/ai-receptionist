import { Request, Response } from 'express';
import twilio from 'twilio';
import { prisma } from '../utils/db';
import { normalizePhoneForLookup } from '../services/twilioService';
import { extractCallSid } from '../utils/callSid';
import { generateLiveResponse } from '../services/aiCallService';
import { persistCallLog } from '../services/callLogPersistenceService';
import {
  getOrCreateSession,
  getSession,
  appendUserMessage,
  appendAssistantMessage,
  getMessages,
  getTranscript,
  incrementNoInputAttempts,
  resetNoInputAttempts,
  deleteSession,
  isCallCompleted,
  markCallCompleted,
  withCallLock,
} from '../services/callSessionService';

const { VoiceResponse } = twilio.twiml;

const VOICE_ACTION_PATH = '/api/telephony/voice';

// One initial greeting + one reprompt before giving up — enough for a
// caller who's briefly distracted, without looping forever on dead air.
const MAX_NO_INPUT_ATTEMPTS = 2;

const GENERIC_CALLER_MESSAGE = "We're unable to complete your call right now. Please try again later. Goodbye.";
const AI_FAILURE_MESSAGE = "I'm sorry, I'm having trouble right now. Please try again in a moment, or call back shortly.";

/**
 * Sends a spoken message and hangs up, as HTTP 200 + TwiML. Twilio only
 * renders TwiML from a 2xx response — returning a 4xx/5xx here would cause
 * Twilio to play its own generic error tone instead of anything we control.
 */
function respondWithVoiceApology(res: Response, message: string) {
  const twiml = new VoiceResponse();
  twiml.say(message);
  twiml.hangup();
  return res.type('text/xml').status(200).send(twiml.toString());
}

/** Speaks a message and gathers another turn of speech from the caller. */
function respondWithSayAndGather(res: Response, message: string) {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: ['speech'],
    action: VOICE_ACTION_PATH,
    method: 'POST',
    speechTimeout: 'auto',
    timeout: 5,
  });
  gather.say(message);

  // Falls through here only if this Gather itself times out with no speech.
  twiml.say("We didn't receive any input. Goodbye.");
  twiml.hangup();

  return res.type('text/xml').status(200).send(twiml.toString());
}

/**
 * POST /api/telephony/voice
 *
 * Phase 4B: a full multi-turn conversation loop on top of Phase 4A's
 * business identification. Twilio remains responsible for speech
 * recognition and speech synthesis — this only ever exchanges plain text
 * with generateLiveResponse() and TwiML with the caller.
 */
export async function handleIncomingVoice(req: Request, res: Response) {
  try {
    const callSid = extractCallSid(req.body);
    const to = typeof req.body?.To === 'string' ? req.body.To.trim() : '';
    const from = typeof req.body?.From === 'string' ? req.body.From.trim() : '';
    const rawSpeech = typeof req.body?.SpeechResult === 'string' ? req.body.SpeechResult : '';
    const speechResult = rawSpeech.trim();

    if (!callSid || !to) {
      console.warn('[telephony] Voice webhook missing CallSid or To.', {
        hasCallSid: Boolean(callSid),
        hasTo: Boolean(to),
      });
      return respondWithVoiceApology(res, GENERIC_CALLER_MESSAGE);
    }

    const normalizedTo = normalizePhoneForLookup(to);
    const normalizedFrom = from ? normalizePhoneForLookup(from) : '';

    let matches;
    try {
      matches = await prisma.business.findMany({
        where: { allocatedPhone: normalizedTo },
        select: { id: true, name: true },
      });
    } catch (dbError: any) {
      console.error('[telephony] Business lookup failed.', {
        callSid,
        message: dbError instanceof Error ? dbError.message : String(dbError),
      });
      return respondWithVoiceApology(res, GENERIC_CALLER_MESSAGE);
    }

    if (matches.length === 0) {
      console.warn('[telephony] No business found for called number.', { callSid, to: normalizedTo });
      return respondWithVoiceApology(res, 'The number you called is not currently available.');
    }

    if (matches.length > 1) {
      // Never guess — routing a real caller to the wrong business is worse
      // than declining the call. allocatedPhone is unique at the schema
      // level, so this should be unreachable in practice; this is
      // defense-in-depth, not an expected runtime path.
      console.error('[telephony] Ambiguous business lookup for called number.', {
        callSid,
        to: normalizedTo,
        matchCount: matches.length,
        businessIds: matches.map((b) => b.id),
      });
      return respondWithVoiceApology(res, GENERIC_CALLER_MESSAGE);
    }

    const business = matches[0];

    // Serialize all work for this CallSid so two overlapping deliveries of
    // the same call's webhook can't interleave reads/writes of its session
    // (e.g. both reading the same history before either has appended to
    // it). Single-process only — see callSessionService.ts.
    return await withCallLock(callSid, async () => {
      if (isCallCompleted(callSid)) {
        // The call-status webhook already reported this call as completed
        // (and, per Phase 4C, may have already deleted its session). A late
        // or duplicate /voice delivery for it must not start a new
        // conversation, recreate a session, or ever reach Groq.
        console.warn('[telephony] Voice webhook received for an already-completed call.', {
          callSid,
          businessId: business.id,
        });
        return respondWithVoiceApology(res, GENERIC_CALLER_MESSAGE);
      }

      const existingSession = getSession(callSid);

      if (existingSession && existingSession.businessId !== business.id) {
        // A later request for this CallSid resolved to a different
        // Business than the session was created with. This should not
        // happen in normal operation (a call's `To` doesn't change
        // mid-call) — fail safely rather than risk mixing one business's
        // conversation/context into another's.
        console.error('[telephony] Business mismatch for existing call session.', {
          callSid,
          sessionBusinessId: existingSession.businessId,
          requestBusinessId: business.id,
        });
        return respondWithVoiceApology(res, GENERIC_CALLER_MESSAGE);
      }

      const isNewSession = !existingSession;
      const session = getOrCreateSession({
        callSid,
        businessId: business.id,
        customerPhone: normalizedFrom,
      });

      if (isNewSession) {
        console.log('[telephony] Incoming call matched business; session created.', {
          callSid,
          businessId: business.id,
        });
      }

      if (!speechResult) {
        // No usable speech on this turn — either this is the very first
        // webhook for the call, or a <Gather> timed out with no input.
        const attempts = incrementNoInputAttempts(callSid);

        if (attempts > MAX_NO_INPUT_ATTEMPTS) {
          console.log('[telephony] Ending call after repeated no-input attempts.', { callSid, attempts });
          return respondWithVoiceApology(res, "We didn't receive any input. Goodbye.");
        }

        if (isNewSession) {
          const greeting = `Thanks for calling ${business.name}. How can I help you today?`;
          appendAssistantMessage(callSid, greeting);
          return respondWithSayAndGather(res, greeting);
        }

        return respondWithSayAndGather(res, "I'm sorry, I didn't catch that. Could you please repeat that?");
      }

      // Caller said something usable — reset the no-input counter and run
      // one AI turn.
      resetNoInputAttempts(callSid);
      appendUserMessage(callSid, speechResult);

      let aiResponse: string;
      try {
        aiResponse = await generateLiveResponse(session.businessId, getMessages(callSid));
      } catch (aiError: any) {
        // Never fabricate a response, never expose the failure to the
        // caller as anything but a short spoken apology, and never log
        // anything that might contain sensitive content (full speech,
        // API keys, raw provider error payloads).
        console.error('[telephony] generateLiveResponse failed.', {
          callSid,
          businessId: session.businessId,
          errorCategory: aiError instanceof Error ? aiError.name || 'Error' : 'UnknownError',
        });
        return respondWithSayAndGather(res, AI_FAILURE_MESSAGE);
      }

      appendAssistantMessage(callSid, aiResponse);
      return respondWithSayAndGather(res, aiResponse);
    });
  } catch (error: any) {
    console.error('[telephony] Unhandled error in voice webhook.', {
      message: error instanceof Error ? error.message : String(error),
    });
    return respondWithVoiceApology(res, GENERIC_CALLER_MESSAGE);
  }
}

/**
 * POST /api/telephony/status
 *
 * Accepts Twilio's call-status callbacks. On `completed`, assembles the
 * session's transcript/duration and persists it via the existing,
 * unmodified processAndSaveCallLog(). Idempotent against duplicate
 * "completed" deliveries for the same CallSid.
 */
export async function handleCallStatus(req: Request, res: Response) {
  try {
    const callSid = extractCallSid(req.body);
    const callStatus = typeof req.body?.CallStatus === 'string' ? req.body.CallStatus : null;

    if (!callSid || !callStatus) {
      console.warn('[telephony] Status webhook missing CallSid or CallStatus.', {
        hasCallSid: Boolean(callSid),
        hasCallStatus: Boolean(callStatus),
      });
      return res.status(400).send('Missing required fields.');
    }

    console.log('[telephony] Call status update.', { callSid, callStatus });

    if (callStatus !== 'completed') {
      return res.status(200).send('OK');
    }

    return await withCallLock(callSid, async () => {
      if (isCallCompleted(callSid)) {
        console.log('[telephony] Duplicate "completed" status ignored.', { callSid });
        return res.status(200).send('OK');
      }

      const session = getSession(callSid);

      if (!session) {
        // No in-memory session for this call — most likely a backend
        // restart mid-call, or a status event for a call that never
        // reached /voice (e.g. rejected earlier). Never fabricate a
        // CallLog from nothing.
        console.warn('[telephony] Completed status for unknown/expired session.', { callSid });
        markCallCompleted(callSid);
        return res.status(200).send('OK');
      }

      const durationSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt.getTime()) / 1000));
      const transcript = getTranscript(callSid);

      if (transcript) {
        // persistCallLog() never throws: on failure it durably records the
        // work in CallLogOutbox instead (see callLogPersistenceService.ts)
        // so a save failure here never means the call's data is lost —
        // just deferred to the retry sweep. The session can be safely
        // deleted either way once the transcript has been handed off.
        await persistCallLog({
          callSid,
          businessId: session.businessId,
          customerPhone: session.customerPhone,
          transcript,
          durationSeconds,
        });
      } else {
        // Call connected but nothing was ever said/recorded — nothing
        // meaningful to summarize or log.
        console.log('[telephony] Completed call had no transcript; skipping CallLog.', { callSid });
      }

      markCallCompleted(callSid);
      deleteSession(callSid);

      return res.status(200).send('OK');
    });
  } catch (error: any) {
    console.error('[telephony] Unhandled error in status webhook.', {
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(200).send('OK');
  }
}
