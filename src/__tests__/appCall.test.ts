import { Response } from 'express';
import { prisma } from '../utils/db';
import { createBusinessProfile } from '../controllers/onboarding.controller';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createCall, endCall, markFailed, getCallStatus, sweepStaleAppCalls } from '../calls/call.service';
import { issueCallToken, verifyCallToken, authenticateCallToken, CallAuthedRequest } from '../calls/call.auth';
import { canTransition, assertTransition } from '../calls/call.state';
import { appendUserMessage, getOrCreateSession, deleteSession } from '../services/callSessionService';
import { processAndSaveCallLog } from '../services/aiCallService';

// Same pattern telephony.test.ts / callLogPersistenceService.test.ts use —
// finalizeCallLog() reuses the EXISTING, unmodified persistCallLog(), which
// calls the real Groq API via processAndSaveCallLog(). Mocking it here
// keeps these tests fast/offline and focused on the call-lifecycle logic
// this module actually owns, not aiCallService's already-tested behavior.
jest.mock('../services/aiCallService', () => ({
  ...jest.requireActual('../services/aiCallService'),
  processAndSaveCallLog: jest.fn(),
}));

const mockProcessAndSaveCallLog = processAndSaveCallLog as jest.Mock;

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

function mockAuthedReq(userId: string, body: Record<string, any> = {}) {
  return { userId, body } as AuthenticatedRequest;
}

async function createTestUser(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: 'irrelevant-for-these-tests', emailVerified: true },
  });
}

async function createReadyBusiness(email: string, name: string) {
  const user = await createTestUser(email);
  const res = mockRes();
  await createBusinessProfile(mockAuthedReq(user.id, { name, type: 'Retail' }), res);
  const business = res.json.mock.calls[0][0];
  await prisma.onboardingState.update({ where: { businessId: business.id }, data: { completed: true } });
  return business;
}

describe('app-calls (in-app WebRTC call lifecycle)', () => {
  afterEach(async () => {
    mockProcessAndSaveCallLog.mockReset();
    // Business cascades from User, and AppCall cascades from Business
    // (see schema.prisma), so deleting the test users is sufficient.
    await prisma.user.deleteMany({ where: { email: { contains: '@app-call-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('call.state transitions', () => {
    it('allows the documented happy-path lifecycle', () => {
      expect(canTransition('CREATED', 'CONNECTING')).toBe(true);
      expect(canTransition('CONNECTING', 'CONNECTED')).toBe(true);
      expect(canTransition('CONNECTED', 'ACTIVE')).toBe(true);
      expect(canTransition('ACTIVE', 'ENDING')).toBe(true);
      expect(canTransition('ENDING', 'ENDED')).toBe(true);
    });

    it('rejects skipping states or transitioning out of a terminal state', () => {
      expect(canTransition('CREATED', 'ACTIVE')).toBe(false);
      expect(canTransition('ENDED', 'ACTIVE')).toBe(false);
      expect(canTransition('FAILED', 'CONNECTING')).toBe(false);
      expect(() => assertTransition('ENDED', 'CONNECTING')).toThrow();
    });

    it('allows FAILED from every non-terminal state', () => {
      expect(canTransition('CREATED', 'FAILED')).toBe(true);
      expect(canTransition('CONNECTING', 'FAILED')).toBe(true);
      expect(canTransition('CONNECTED', 'FAILED')).toBe(true);
      expect(canTransition('ACTIVE', 'FAILED')).toBe(true);
      expect(canTransition('ENDING', 'FAILED')).toBe(true);
    });
  });

  describe('call-token auth', () => {
    it('round-trips valid claims', () => {
      const token = issueCallToken({ callId: 'call-1', businessId: 'biz-1', scope: 'app_call' });
      const claims = verifyCallToken(token);
      expect(claims.callId).toBe('call-1');
      expect(claims.businessId).toBe('biz-1');
    });

    it('rejects a token whose callId does not match the requested route param', () => {
      const token = issueCallToken({ callId: 'call-A', businessId: 'biz-1', scope: 'app_call' });
      const req = {
        headers: { authorization: `Bearer ${token}` },
        params: { callId: 'call-B' },
      } as unknown as CallAuthedRequest;
      const res = mockRes();
      const next = jest.fn();

      authenticateCallToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('rejects a missing or garbage token', () => {
      const req = { headers: {}, params: { callId: 'call-1' } } as unknown as CallAuthedRequest;
      const res = mockRes();
      const next = jest.fn();

      authenticateCallToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('accepts a valid token for the matching callId and attaches claims', () => {
      const token = issueCallToken({ callId: 'call-1', businessId: 'biz-1', scope: 'app_call' });
      const req = {
        headers: { authorization: `Bearer ${token}` },
        params: { callId: 'call-1' },
      } as unknown as CallAuthedRequest;
      const res = mockRes();
      const next = jest.fn();

      authenticateCallToken(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.callClaims?.callId).toBe('call-1');
    });
  });

  describe('createCall (business validation)', () => {
    it('rejects a call for a business that does not exist', async () => {
      await expect(createCall('nonexistent-business-id')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('rejects a call for a business that has not completed onboarding', async () => {
      const user = await createTestUser('incomplete@app-call-test.dev');
      const res = mockRes();
      await createBusinessProfile(mockAuthedReq(user.id, { name: 'Incomplete Biz', type: 'Retail' }), res);
      const business = res.json.mock.calls[0][0];

      await expect(createCall(business.id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('creates a call and a matching call-scoped token for a ready business', async () => {
      const business = await createReadyBusiness('ready@app-call-test.dev', 'Ready Biz');

      const { callId, callToken } = await createCall(business.id);
      expect(callId).toBeTruthy();

      const claims = verifyCallToken(callToken);
      expect(claims.callId).toBe(callId);
      expect(claims.businessId).toBe(business.id);

      const status = await getCallStatus(callId);
      expect(status?.state).toBe('CREATED');
      expect(status?.businessId).toBe(business.id);
    });
  });

  describe('endCall', () => {
    it('transitions a freshly created call to CANCELLED (never having connected)', async () => {
      const business = await createReadyBusiness('cancel@app-call-test.dev', 'Cancel Biz');
      const { callId } = await createCall(business.id);

      const result = await endCall(callId);
      expect(result.state).toBe('CANCELLED');
      expect(result.endedAt).not.toBeNull();
    });

    it('persists a CallLog when the call produced a transcript', async () => {
      const business = await createReadyBusiness('transcript@app-call-test.dev', 'Transcript Biz');
      const { callId } = await createCall(business.id);

      // Simulate the voice pipeline having appended conversation turns —
      // reuses the exact in-memory session the Twilio path also uses.
      const callSid = `app_${callId}`;
      getOrCreateSession({ callSid, businessId: business.id, customerPhone: `app:${callId}` });
      appendUserMessage(callSid, 'Are you open on Sunday?');

      // Stands in for the real (network-calling) processAndSaveCallLog —
      // this test is about endCall()/finalizeCallLog() wiring the existing
      // persistence pipeline correctly, not re-testing aiCallService itself.
      mockProcessAndSaveCallLog.mockImplementation(async (params: any) => {
        const customer = await prisma.customer.create({
          data: { businessId: params.businessId, phone: params.customerPhone, name: 'Test Customer' },
        });
        const callLog = await prisma.callLog.create({
          data: {
            businessId: params.businessId,
            customerId: customer.id,
            durationSeconds: params.durationSeconds,
            outcomeTag: 'ANSWERED',
            transcript: params.transcript,
            summary: 'Test summary.',
          },
        });
        return { callLog, analysis: { summary: 'Test summary.', outcomeTag: 'ANSWERED', unansweredQuestions: [] } };
      });

      await endCall(callId);

      const callLog = await prisma.callLog.findUnique({ where: { callSid } });
      expect(callLog).not.toBeNull();
      expect(callLog?.businessId).toBe(business.id);
      expect(callLog?.transcript).toContain('Are you open on Sunday?');

      deleteSession(callSid);
    });

    it('rejects ending a call that does not exist', async () => {
      await expect(endCall('nonexistent-call-id')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('is idempotent-safe: ending an already-ended call does not throw', async () => {
      const business = await createReadyBusiness('double-end@app-call-test.dev', 'Double End Biz');
      const { callId } = await createCall(business.id);

      await endCall(callId);
      await expect(endCall(callId)).resolves.toMatchObject({ state: 'CANCELLED' });
    });
  });

  describe('markFailed', () => {
    it('transitions a call to FAILED with a reason and persists the transcript so far', async () => {
      const business = await createReadyBusiness('fail@app-call-test.dev', 'Fail Biz');
      const { callId } = await createCall(business.id);

      await markFailed(callId, 'WebRTC connection dropped.');

      const status = await getCallStatus(callId);
      expect(status?.state).toBe('FAILED');
      expect(status?.failureReason).toBe('WebRTC connection dropped.');
    });

    it('does nothing for a call that does not exist, rather than throwing', async () => {
      await expect(markFailed('nonexistent-call-id', 'irrelevant')).resolves.toBeUndefined();
    });
  });

  describe('sweepStaleAppCalls', () => {
    it('marks a long-abandoned non-terminal call as FAILED', async () => {
      const business = await createReadyBusiness('stale@app-call-test.dev', 'Stale Biz');
      const { callId } = await createCall(business.id);

      const farFuture = new Date(Date.now() + 2 * 60 * 60_000);
      const removed = await sweepStaleAppCalls(farFuture);

      expect(removed).toBeGreaterThanOrEqual(1);
      const status = await getCallStatus(callId);
      expect(status?.state).toBe('FAILED');
    });

    it('leaves a recent non-terminal call untouched', async () => {
      const business = await createReadyBusiness('fresh@app-call-test.dev', 'Fresh Biz');
      const { callId } = await createCall(business.id);

      await sweepStaleAppCalls(new Date());

      const status = await getCallStatus(callId);
      expect(status?.state).toBe('CREATED');
    });
  });
});
