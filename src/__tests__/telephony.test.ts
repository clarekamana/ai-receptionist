import { Request, Response } from 'express';
import twilio from 'twilio';

import { verifyTwilioSignature } from '../middlewares/twilioSignature.middleware';
import { handleIncomingVoice, handleCallStatus } from '../controllers/telephony.controller';
import * as twilioService from '../services/twilioService';
import { prisma } from '../utils/db';
import { createBusinessProfile } from '../controllers/onboarding.controller';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { getSession, deleteSession } from '../services/callSessionService';
import { generateLiveResponse, processAndSaveCallLog } from '../services/aiCallService';

jest.mock('../services/aiCallService', () => ({
  ...jest.requireActual('../services/aiCallService'),
  generateLiveResponse: jest.fn(),
  processAndSaveCallLog: jest.fn(),
}));

const mockGenerateLiveResponse = generateLiveResponse as jest.Mock;
const mockProcessAndSaveCallLog = processAndSaveCallLog as jest.Mock;

beforeEach(() => {
  mockGenerateLiveResponse.mockReset();
  // No default resolved value: callLogPersistenceService.ts stamps a real
  // CallLog row's id after a successful save, so tests exercising that path
  // must provide a mockResolvedValueOnce backed by a real row (see
  // mockSuccessfulCallLogSave below) rather than a bare {} that would make
  // the follow-up update fail against the real test DB.
  mockProcessAndSaveCallLog.mockReset();
});

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL!;
const VOICE_PATH = '/api/telephony/voice';
const STATUS_PATH = '/api/telephony/status';

function mockRes() {
  const res: any = {};
  res.type = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { type: jest.Mock; status: jest.Mock; send: jest.Mock; json: jest.Mock };
}

function mockWebhookReq(opts: {
  originalUrl?: string;
  body?: Record<string, any>;
  signature?: string | null;
}): Request {
  const body = opts.body ?? {};
  const headers: Record<string, string> = {};
  if (opts.signature !== null) {
    headers['X-Twilio-Signature'] = opts.signature ?? twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      `${PUBLIC_BASE_URL}${opts.originalUrl ?? VOICE_PATH}`,
      body
    );
  }

  return {
    originalUrl: opts.originalUrl ?? VOICE_PATH,
    body,
    header: (name: string) => headers[name],
  } as unknown as Request;
}

async function createTestUser(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: 'irrelevant-for-these-tests', emailVerified: true },
  });
}

function mockAuthedReq(userId: string, body: Record<string, any>) {
  return { userId, body } as AuthenticatedRequest;
}

async function createTestBusiness(userId: string, name: string) {
  const res = mockRes();
  await createBusinessProfile(mockAuthedReq(userId, { name, type: 'Retail' }), res as any);
  return res.json.mock.calls[0][0];
}

/**
 * Simulates a successful processAndSaveCallLog() without touching Groq: a
 * real CallLog row is created directly (bypassing aiCallService entirely),
 * and the mock resolves with it. This is required because
 * callLogPersistenceService.ts stamps `callSid` onto the row returned by
 * processAndSaveCallLog via a real `prisma.callLog.update` — a bare mocked
 * `{}` with no `id` would make that update fail against the real test DB.
 */
async function mockSuccessfulCallLogSave(businessId: string) {
  const callLog = await prisma.callLog.create({
    data: {
      businessId,
      durationSeconds: 0,
      outcomeTag: 'ANSWERED',
      transcript: 'placeholder',
      summary: 'placeholder',
    },
  });
  mockProcessAndSaveCallLog.mockResolvedValueOnce({ callLog, analysis: {} });
  return callLog;
}

describe('Twilio signature verification (real validation path)', () => {
  it('calls next() for a request with a valid signature', () => {
    const req = mockWebhookReq({ body: { CallSid: 'CAxxx', To: '+15550001111' } });
    const res = mockRes();
    const next = jest.fn();

    verifyTwilioSignature(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid signature', () => {
    const req = mockWebhookReq({
      body: { CallSid: 'CAxxx', To: '+15550001111' },
      signature: 'this-is-not-a-real-signature',
    });
    const res = mockRes();
    const next = jest.fn();

    verifyTwilioSignature(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects a request with no signature header at all', () => {
    const req = mockWebhookReq({ body: { CallSid: 'CAxxx' }, signature: null });
    const res = mockRes();
    const next = jest.fn();

    verifyTwilioSignature(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('fails closed with 500 when Twilio config is missing, without accepting the request', () => {
    const getConfigSpy = jest.spyOn(twilioService, 'getTwilioConfig').mockReturnValueOnce(null);

    const req = mockWebhookReq({ body: { CallSid: 'CAxxx' } });
    const res = mockRes();
    const next = jest.fn();

    verifyTwilioSignature(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);

    getConfigSpy.mockRestore();
  });
});

describe('handleIncomingVoice (business identification + initial TwiML)', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@telephony-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns a safe TwiML apology when CallSid or To is missing', async () => {
    const res = mockRes();

    await handleIncomingVoice({ body: { To: '+15550001111' } } as unknown as Request, res as any);

    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.status).toHaveBeenCalledWith(200);
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain('<Say>');
    expect(twiml).toContain('<Hangup');
  });

  it('greets the caller and gathers speech when exactly one business matches', async () => {
    const user = await createTestUser('one-match@telephony-test.dev');
    const business = await createTestBusiness(user.id, 'Golden Gate Dental');
    await prisma.business.update({ where: { id: business.id }, data: { allocatedPhone: '+15005550001' } });

    const res = mockRes();
    await handleIncomingVoice(
      { body: { CallSid: 'CA_one_match', To: '+15005550001', From: '+15559998888' } } as unknown as Request,
      res as any
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain('<Gather');
    expect(twiml).toContain('Golden Gate Dental');
  });

  it('returns the unknown-number TwiML fallback when no business matches', async () => {
    const res = mockRes();

    await handleIncomingVoice(
      { body: { CallSid: 'CA_unknown', To: '+19995551234' } } as unknown as Request,
      res as any
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain('not currently available');
    expect(twiml).not.toContain('<Gather');
  });

  it('never picks an arbitrary business when the lookup is ambiguous', async () => {
    const user = await createTestUser('ambiguous@telephony-test.dev');
    const businessA = await createTestBusiness(user.id, 'Business A');

    // allocatedPhone is @unique at the schema level, so two real rows can't
    // share a value — this simulates the defense-in-depth path (e.g. a
    // manual DB edit or a future migration gap) rather than a state
    // reachable through the normal API today.
    const findManySpy = jest.spyOn(prisma.business, 'findMany').mockResolvedValueOnce([
      { id: businessA.id, name: 'Business A' },
      { id: 'fake-business-b', name: 'Business B' },
    ] as any);

    const res = mockRes();
    await handleIncomingVoice(
      { body: { CallSid: 'CA_ambiguous', To: '+15005559999' } } as unknown as Request,
      res as any
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).not.toContain('Business A');
    expect(twiml).not.toContain('Business B');
    expect(twiml).not.toContain('<Gather');

    findManySpy.mockRestore();
  });
});

describe('handleIncomingVoice — AI conversation loop (Phase 4B)', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@voiceloop-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setUpBusiness(emailPrefix: string, name: string, allocatedPhone: string) {
    const user = await createTestUser(`${emailPrefix}@voiceloop-test.dev`);
    const business = await createTestBusiness(user.id, name);
    await prisma.business.update({ where: { id: business.id }, data: { allocatedPhone } });
    return business;
  }

  it('creates a session on the initial request (no SpeechResult)', async () => {
    const business = await setUpBusiness('initial', 'Session Test Biz', '+15005551001');
    const callSid = 'CA_initial_session';

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551001', From: '+15559990001' } } as unknown as Request,
      mockRes() as any
    );

    const session = getSession(callSid);
    expect(session).toBeDefined();
    expect(session?.businessId).toBe(business.id);

    deleteSession(callSid);
  });

  it('does not call generateLiveResponse on the initial request', async () => {
    await setUpBusiness('no-ai-initial', 'No AI Initial Biz', '+15005551002');
    const callSid = 'CA_no_ai_initial';

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551002' } } as unknown as Request,
      mockRes() as any
    );

    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();

    deleteSession(callSid);
  });

  it('retrieves the existing session on a speech turn and accumulates history', async () => {
    await setUpBusiness('speech-turn', 'Speech Turn Biz', '+15005551003');
    const callSid = 'CA_speech_turn';

    // Initial webhook: creates the session + speaks the greeting.
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551003' } } as unknown as Request,
      mockRes() as any
    );
    const sessionAfterGreeting = getSession(callSid);
    expect(sessionAfterGreeting?.messages).toHaveLength(1); // the greeting, as an assistant message

    mockGenerateLiveResponse.mockResolvedValueOnce('I can help you book that.');

    const res = mockRes();
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551003', SpeechResult: 'I need an appointment.' } } as unknown as Request,
      res as any
    );

    // Same session, not a new one.
    const sessionAfterSpeech = getSession(callSid);
    expect(sessionAfterSpeech).toBe(sessionAfterGreeting);

    // SpeechResult became a user message.
    expect(sessionAfterSpeech?.messages).toContainEqual({ role: 'user', content: 'I need an appointment.' });

    // generateLiveResponse received the accumulated history (greeting + new user turn).
    expect(mockGenerateLiveResponse).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        { role: 'assistant', content: expect.any(String) },
        { role: 'user', content: 'I need an appointment.' },
      ])
    );

    // AI response became an assistant message.
    expect(sessionAfterSpeech?.messages).toContainEqual({ role: 'assistant', content: 'I can help you book that.' });

    // TwiML contains the AI response inside <Say> and another <Gather>.
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain('I can help you book that.');
    expect(twiml).toContain('<Say>');
    expect(twiml).toContain('<Gather');

    deleteSession(callSid);
  });

  it('does not call Groq for whitespace-only speech, and reprompts instead', async () => {
    await setUpBusiness('empty-speech', 'Empty Speech Biz', '+15005551004');
    const callSid = 'CA_empty_speech';

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551004' } } as unknown as Request,
      mockRes() as any
    );

    const res = mockRes();
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551004', SpeechResult: '   ' } } as unknown as Request,
      res as any
    );

    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();
    const session = getSession(callSid);
    expect(session?.messages.some((m) => m.role === 'user')).toBe(false);

    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain('<Gather');

    deleteSession(callSid);
  });

  it('ends the call gracefully after repeated no-input attempts instead of looping forever', async () => {
    await setUpBusiness('no-input-loop', 'No Input Loop Biz', '+15005551005');
    const callSid = 'CA_no_input_loop';
    const req = () =>
      ({ body: { CallSid: callSid, To: '+15005551005' } } as unknown as Request);

    await handleIncomingVoice(req(), mockRes() as any); // attempt 1: greeting
    await handleIncomingVoice(req(), mockRes() as any); // attempt 2: reprompt

    const finalRes = mockRes();
    await handleIncomingVoice(req(), finalRes as any); // attempt 3: give up

    const twiml = finalRes.send.mock.calls[0][0];
    expect(twiml).not.toContain('<Gather');
    expect(twiml).toContain('<Hangup');
    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();

    deleteSession(callSid);
  });

  it('handles a speech turn for an unknown/expired session without crashing', async () => {
    await setUpBusiness('orphan-session', 'Orphan Session Biz', '+15005551006');
    const callSid = 'CA_orphan_session';

    // No prior call to create a session for this CallSid.
    const res = mockRes();
    mockGenerateLiveResponse.mockResolvedValueOnce('Sure, I can help.');

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551006', SpeechResult: 'Hello?' } } as unknown as Request,
      res as any
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain('<Say>');
    expect(getSession(callSid)).toBeDefined();

    deleteSession(callSid);
  });

  it('returns a spoken fallback (not JSON, not a thrown error) when generateLiveResponse fails', async () => {
    await setUpBusiness('ai-failure', 'AI Failure Biz', '+15005551007');
    const callSid = 'CA_ai_failure';

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551007' } } as unknown as Request,
      mockRes() as any
    );

    mockGenerateLiveResponse.mockRejectedValueOnce(new Error('Groq is unavailable'));

    const res = mockRes();
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551007', SpeechResult: 'Anyone there?' } } as unknown as Request,
      res as any
    );

    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.status).toHaveBeenCalledWith(200);
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain('having trouble right now');
    expect(twiml).toContain('<Gather');
    expect(twiml).not.toContain('Groq is unavailable');

    deleteSession(callSid);
  });

  it('rejects safely, without calling Groq, when a later request resolves to a different Business than the session', async () => {
    const businessA = await setUpBusiness('mismatch-a', 'Mismatch Business A', '+15005551008');
    const businessB = await setUpBusiness('mismatch-b', 'Mismatch Business B', '+15005551009');
    const callSid = 'CA_business_mismatch';

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551008' } } as unknown as Request,
      mockRes() as any
    );
    expect(getSession(callSid)?.businessId).toBe(businessA.id);

    const res = mockRes();
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005551009', SpeechResult: 'Hello' } } as unknown as Request,
      res as any
    );

    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).not.toContain('<Gather');
    // The session must still point at the original business, untouched.
    expect(getSession(callSid)?.businessId).toBe(businessA.id);

    deleteSession(callSid);
  });
});

describe('handleCallStatus', () => {
  it('accepts a valid status payload', async () => {
    const res = mockRes();

    await handleCallStatus(
      { body: { CallSid: 'CA_status_1', CallStatus: 'completed' } } as unknown as Request,
      res as any
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a payload missing CallSid or CallStatus', async () => {
    const res = mockRes();

    await handleCallStatus({ body: { CallStatus: 'ringing' } } as unknown as Request, res as any);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  describe('call completion (Phase 4B)', () => {
    afterEach(async () => {
      await prisma.user.deleteMany({ where: { email: { contains: '@statuscomplete-test.dev' } } });
      // CallLogOutbox has no relation to Business, so it isn't cascade-deleted above.
      await prisma.callLogOutbox.deleteMany({});
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    async function setUpCallWithTranscript(emailPrefix: string, callSid: string, allocatedPhone: string) {
      const user = await createTestUser(`${emailPrefix}@statuscomplete-test.dev`);
      const business = await createTestBusiness(user.id, 'Status Test Biz');
      await prisma.business.update({ where: { id: business.id }, data: { allocatedPhone } });

      await handleIncomingVoice(
        { body: { CallSid: callSid, To: allocatedPhone, From: '+15559991234' } } as unknown as Request,
        mockRes() as any
      );

      mockGenerateLiveResponse.mockResolvedValueOnce('Sure, tomorrow at 2pm works.');
      await handleIncomingVoice(
        { body: { CallSid: callSid, To: allocatedPhone, SpeechResult: 'Book me for tomorrow at 2pm.' } } as unknown as Request,
        mockRes() as any
      );

      return business;
    }

    it('triggers processAndSaveCallLog with the assembled transcript on a completed status, and stamps the CallLog', async () => {
      const callSid = 'CA_complete_1';
      const business = await setUpCallWithTranscript('complete-1', callSid, '+15005552001');
      await mockSuccessfulCallLogSave(business.id);

      await handleCallStatus(
        { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
        mockRes() as any
      );

      expect(mockProcessAndSaveCallLog).toHaveBeenCalledTimes(1);
      const args = mockProcessAndSaveCallLog.mock.calls[0][0];
      expect(args.businessId).toBe(business.id);
      expect(args.customerPhone).toBe('+15559991234');
      expect(args.transcript).toContain('Caller: Book me for tomorrow at 2pm.');
      expect(args.transcript).toContain('Assistant: Sure, tomorrow at 2pm works.');
      expect(typeof args.durationSeconds).toBe('number');
      expect(args.durationSeconds).toBeGreaterThanOrEqual(0);

      const stamped = await prisma.callLog.findUnique({ where: { callSid } });
      expect(stamped).not.toBeNull();

      const outboxRow = await prisma.callLogOutbox.findUnique({ where: { callSid } });
      expect(outboxRow).toBeNull();
    });

    it('deletes the in-memory session after successful completion', async () => {
      const callSid = 'CA_complete_2';
      const business = await setUpCallWithTranscript('complete-2', callSid, '+15005552002');
      await mockSuccessfulCallLogSave(business.id);

      expect(getSession(callSid)).toBeDefined();

      await handleCallStatus(
        { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
        mockRes() as any
      );

      expect(getSession(callSid)).toBeUndefined();
    });

    it('does not process the same completed call twice', async () => {
      const callSid = 'CA_complete_3';
      const business = await setUpCallWithTranscript('complete-3', callSid, '+15005552003');
      await mockSuccessfulCallLogSave(business.id);

      await handleCallStatus(
        { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
        mockRes() as any
      );
      await handleCallStatus(
        { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
        mockRes() as any
      );

      expect(mockProcessAndSaveCallLog).toHaveBeenCalledTimes(1);
    });

    it('handles a completed status for an unknown CallSid safely, without fabricating a CallLog', async () => {
      const res = mockRes();

      await handleCallStatus(
        { body: { CallSid: 'CA_never_existed', CallStatus: 'completed' } } as unknown as Request,
        res as any
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockProcessAndSaveCallLog).not.toHaveBeenCalled();
    });

    it('returns 200, does not throw, and durably queues the call for retry when processAndSaveCallLog fails', async () => {
      const callSid = 'CA_complete_fail';
      await setUpCallWithTranscript('complete-fail', callSid, '+15005552004');

      mockProcessAndSaveCallLog.mockRejectedValueOnce(new Error('DB unavailable'));

      const res = mockRes();
      await expect(
        handleCallStatus(
          { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
          res as any
        )
      ).resolves.not.toThrow();

      expect(res.status).toHaveBeenCalledWith(200);
      // Session cleanup still happens — the transcript is durably preserved
      // in the outbox instead, so nothing is lost by deleting it.
      expect(getSession(callSid)).toBeUndefined();

      const outboxRow = await prisma.callLogOutbox.findUnique({ where: { callSid } });
      expect(outboxRow).not.toBeNull();
      expect(outboxRow?.status).toBe('PENDING');
      expect(outboxRow?.transcript).toContain('Caller: Book me for tomorrow at 2pm.');
    });
  });
});

describe('Phase 4C: completion/voice race safety', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@race-test.dev' } } });
    await prisma.callLogOutbox.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setUpBusiness(emailPrefix: string, allocatedPhone: string) {
    const user = await prisma.user.create({
      data: { email: `${emailPrefix}@race-test.dev`, passwordHash: 'x', emailVerified: true },
    });
    const res = mockRes();
    await createBusinessProfile(mockAuthedReq(user.id, { name: 'Race Test Biz', type: 'Retail' }), res as any);
    const business = res.json.mock.calls[0][0];
    await prisma.business.update({ where: { id: business.id }, data: { allocatedPhone } });
    return business;
  }

  it('a late /voice request for an already-completed call does not create a new session or call Groq', async () => {
    const business = await setUpBusiness('late-voice', '+15005553001');
    const callSid = 'CA_race_late_voice';

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005553001' } } as unknown as Request,
      mockRes() as any
    );
    mockGenerateLiveResponse.mockResolvedValueOnce('Sure thing.');
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005553001', SpeechResult: 'Book an appointment.' } } as unknown as Request,
      mockRes() as any
    );

    await mockSuccessfulCallLogSave(business.id);
    await handleCallStatus(
      { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
      mockRes() as any
    );
    expect(getSession(callSid)).toBeUndefined();

    mockGenerateLiveResponse.mockClear();
    const lateRes = mockRes();
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005553001', SpeechResult: 'Hello? Still there?' } } as unknown as Request,
      lateRes as any
    );

    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();
    expect(getSession(callSid)).toBeUndefined();
    const twiml = lateRes.send.mock.calls[0][0];
    expect(twiml).not.toContain('<Gather');
  });

  it('a duplicate completed status after the session is gone remains idempotent and does not re-save', async () => {
    const business = await setUpBusiness('dup-after-gone', '+15005553002');
    const callSid = 'CA_race_dup_after_gone';

    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005553002' } } as unknown as Request,
      mockRes() as any
    );
    mockGenerateLiveResponse.mockResolvedValueOnce('Sure.');
    await handleIncomingVoice(
      { body: { CallSid: callSid, To: '+15005553002', SpeechResult: 'Hi.' } } as unknown as Request,
      mockRes() as any
    );

    await mockSuccessfulCallLogSave(business.id);
    await handleCallStatus(
      { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
      mockRes() as any
    );

    const secondRes = mockRes();
    await handleCallStatus(
      { body: { CallSid: callSid, CallStatus: 'completed' } } as unknown as Request,
      secondRes as any
    );

    expect(secondRes.status).toHaveBeenCalledWith(200);
    expect(mockProcessAndSaveCallLog).toHaveBeenCalledTimes(1);
  });
});
