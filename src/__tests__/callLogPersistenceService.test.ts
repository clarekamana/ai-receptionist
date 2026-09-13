import {
  persistCallLog,
  runOutboxRetrySweep,
  backoffDelayMs,
} from '../services/callLogPersistenceService';
import { processAndSaveCallLog } from '../services/aiCallService';
import { prisma } from '../utils/db';
import { createBusinessProfile } from '../controllers/onboarding.controller';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

jest.mock('../services/aiCallService', () => ({
  ...jest.requireActual('../services/aiCallService'),
  processAndSaveCallLog: jest.fn(),
}));

const mockProcessAndSaveCallLog = processAndSaveCallLog as jest.Mock;

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockAuthedReq(userId: string, body: Record<string, any>) {
  return { userId, body } as AuthenticatedRequest;
}

async function createTestBusiness(emailPrefix: string) {
  const user = await prisma.user.create({
    data: { email: `${emailPrefix}@outbox-test.dev`, passwordHash: 'x', emailVerified: true },
  });
  const res = mockRes();
  await createBusinessProfile(mockAuthedReq(user.id, { name: 'Outbox Test Biz', type: 'Retail' }), res);
  return res.json.mock.calls[0][0];
}

async function createRealCallLog(businessId: string) {
  return prisma.callLog.create({
    data: { businessId, durationSeconds: 0, outcomeTag: 'ANSWERED', transcript: 'placeholder', summary: 'placeholder' },
  });
}

describe('callLogPersistenceService', () => {
  beforeEach(() => {
    mockProcessAndSaveCallLog.mockReset();
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@outbox-test.dev' } } });
    await prisma.callLogOutbox.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('persistCallLog', () => {
    it('creates an outbox record with the retry data when the save fails', async () => {
      const business = await createTestBusiness('save-fail');
      mockProcessAndSaveCallLog.mockRejectedValueOnce(new Error('Groq unavailable'));

      const result = await persistCallLog({
        callSid: 'CA_outbox_fail_1',
        businessId: business.id,
        customerPhone: '+15551234567',
        transcript: 'Caller: Hi.\nAssistant: Hello!',
        durationSeconds: 42,
      });

      expect(result.persisted).toBe(false);

      const row = await prisma.callLogOutbox.findUnique({ where: { callSid: 'CA_outbox_fail_1' } });
      expect(row).not.toBeNull();
      expect(row?.businessId).toBe(business.id);
      expect(row?.customerPhone).toBe('+15551234567');
      expect(row?.transcript).toBe('Caller: Hi.\nAssistant: Hello!');
      expect(row?.durationSeconds).toBe(42);
      expect(row?.status).toBe('PENDING');
      expect(row?.attempts).toBe(0);
      expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(row?.createdAt).toBeInstanceOf(Date);
    });

    it('does not create a pending outbox record when the save succeeds', async () => {
      const business = await createTestBusiness('save-success');
      const realLog = await createRealCallLog(business.id);
      mockProcessAndSaveCallLog.mockResolvedValueOnce({ callLog: realLog, analysis: {} });

      const result = await persistCallLog({
        callSid: 'CA_outbox_success_1',
        businessId: business.id,
        customerPhone: '+15551234567',
        transcript: 'Caller: Hi.\nAssistant: Hello!',
        durationSeconds: 10,
      });

      expect(result.persisted).toBe(true);

      const row = await prisma.callLogOutbox.findUnique({ where: { callSid: 'CA_outbox_success_1' } });
      expect(row).toBeNull();

      const stamped = await prisma.callLog.findUnique({ where: { callSid: 'CA_outbox_success_1' } });
      expect(stamped).not.toBeNull();
    });

    it('never calls processAndSaveCallLog again for a CallSid that already has a CallLog', async () => {
      const business = await createTestBusiness('already-logged');
      await prisma.callLog.create({
        data: {
          businessId: business.id,
          callSid: 'CA_already_logged',
          durationSeconds: 5,
          outcomeTag: 'ANSWERED',
          transcript: 'x',
          summary: 'x',
        },
      });

      const result = await persistCallLog({
        callSid: 'CA_already_logged',
        businessId: business.id,
        customerPhone: '+1555',
        transcript: 'Caller: Hi.',
        durationSeconds: 5,
      });

      expect(result.persisted).toBe(true);
      expect(mockProcessAndSaveCallLog).not.toHaveBeenCalled();
    });
  });

  describe('backoffDelayMs (bounded exponential backoff)', () => {
    it('grows with each attempt but never exceeds the configured maximum', () => {
      const first = backoffDelayMs(1);
      const second = backoffDelayMs(2);
      const third = backoffDelayMs(3);

      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);

      const farOut = backoffDelayMs(20); // would be astronomically large unbounded
      expect(farOut).toBeLessThanOrEqual(30 * 60_000);
    });
  });

  describe('runOutboxRetrySweep', () => {
    it('retries a due PENDING record and marks it COMPLETED on success', async () => {
      const business = await createTestBusiness('retry-success');
      await prisma.callLogOutbox.create({
        data: {
          callSid: 'CA_retry_success',
          businessId: business.id,
          customerPhone: '+1555',
          transcript: 'Caller: Hi.',
          durationSeconds: 12,
          status: 'PENDING',
          attempts: 1,
          nextAttemptAt: new Date(Date.now() - 1000), // already due
        },
      });

      const realLog = await createRealCallLog(business.id);
      mockProcessAndSaveCallLog.mockResolvedValueOnce({ callLog: realLog, analysis: {} });

      const result = await runOutboxRetrySweep();

      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);

      const row = await prisma.callLogOutbox.findUnique({ where: { callSid: 'CA_retry_success' } });
      expect(row?.status).toBe('COMPLETED');

      const stamped = await prisma.callLog.findUnique({ where: { callSid: 'CA_retry_success' } });
      expect(stamped).not.toBeNull();
    });

    it('increments attempts and reschedules on a failed retry, without exceeding maxAttempts', async () => {
      const business = await createTestBusiness('retry-fail');
      await prisma.callLogOutbox.create({
        data: {
          callSid: 'CA_retry_fail',
          businessId: business.id,
          customerPhone: '+1555',
          transcript: 'Caller: Hi.',
          durationSeconds: 12,
          status: 'PENDING',
          attempts: 1,
          maxAttempts: 5,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      mockProcessAndSaveCallLog.mockRejectedValueOnce(new Error('still unavailable'));

      const result = await runOutboxRetrySweep();

      expect(result.failed).toBe(1);

      const row = await prisma.callLogOutbox.findUnique({ where: { callSid: 'CA_retry_fail' } });
      expect(row?.status).toBe('PENDING');
      expect(row?.attempts).toBe(2);
      expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('stops retrying once maxAttempts is reached, marking the record FAILED', async () => {
      const business = await createTestBusiness('retry-exhausted');
      await prisma.callLogOutbox.create({
        data: {
          callSid: 'CA_retry_exhausted',
          businessId: business.id,
          customerPhone: '+1555',
          transcript: 'Caller: Hi.',
          durationSeconds: 12,
          status: 'PENDING',
          attempts: 4,
          maxAttempts: 5,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      mockProcessAndSaveCallLog.mockRejectedValueOnce(new Error('still unavailable'));

      const result = await runOutboxRetrySweep();

      expect(result.exhausted).toBe(1);

      const row = await prisma.callLogOutbox.findUnique({ where: { callSid: 'CA_retry_exhausted' } });
      expect(row?.status).toBe('FAILED');
      expect(row?.attempts).toBe(5);

      // A FAILED record must never be picked up by a later sweep.
      mockProcessAndSaveCallLog.mockClear();
      const secondSweep = await runOutboxRetrySweep();
      expect(secondSweep.attempted).toBe(0);
      expect(mockProcessAndSaveCallLog).not.toHaveBeenCalled();
    });

    it('does not create a duplicate CallLog when a retry runs against a CallSid already logged elsewhere', async () => {
      const business = await createTestBusiness('retry-duplicate-guard');
      await prisma.callLog.create({
        data: {
          businessId: business.id,
          callSid: 'CA_retry_duplicate_guard',
          durationSeconds: 9,
          outcomeTag: 'ANSWERED',
          transcript: 'already saved',
          summary: 'already saved',
        },
      });
      await prisma.callLogOutbox.create({
        data: {
          callSid: 'CA_retry_duplicate_guard',
          businessId: business.id,
          customerPhone: '+1555',
          transcript: 'Caller: Hi.',
          durationSeconds: 9,
          status: 'PENDING',
          attempts: 1,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      const result = await runOutboxRetrySweep();

      expect(result.succeeded).toBe(1);
      expect(mockProcessAndSaveCallLog).not.toHaveBeenCalled();

      const logs = await prisma.callLog.findMany({ where: { callSid: 'CA_retry_duplicate_guard' } });
      expect(logs).toHaveLength(1);

      const row = await prisma.callLogOutbox.findUnique({ where: { callSid: 'CA_retry_duplicate_guard' } });
      expect(row?.status).toBe('COMPLETED');
    });

    it('does not pick up records that are not yet due', async () => {
      const business = await createTestBusiness('not-due');
      await prisma.callLogOutbox.create({
        data: {
          callSid: 'CA_not_due',
          businessId: business.id,
          customerPhone: '+1555',
          transcript: 'Caller: Hi.',
          durationSeconds: 9,
          status: 'PENDING',
          attempts: 1,
          nextAttemptAt: new Date(Date.now() + 60 * 60_000), // an hour from now
        },
      });

      const result = await runOutboxRetrySweep();

      expect(result.attempted).toBe(0);
      expect(mockProcessAndSaveCallLog).not.toHaveBeenCalled();
    });
  });
});
