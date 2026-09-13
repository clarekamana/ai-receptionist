import { Response } from 'express';

import { createBusinessProfile } from '../controllers/onboarding.controller';
import { getEscalatedCalls, updateEscalationStatus } from '../controllers/calls.controller';
import { persistCallLog } from '../services/callLogPersistenceService';
import { processAndSaveCallLog } from '../services/aiCallService';
import { sendEscalationNotice } from '../services/emailService';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { prisma } from '../utils/db';

jest.mock('../services/aiCallService', () => ({
  ...jest.requireActual('../services/aiCallService'),
  processAndSaveCallLog: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEscalationNotice: jest.fn(),
}));

const mockProcessAndSaveCallLog = processAndSaveCallLog as jest.Mock;
const mockSendEscalationNotice = sendEscalationNotice as jest.Mock;

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

function mockAuthedReq(userId: string, body: Record<string, any> = {}, params: Record<string, any> = {}) {
  return { userId, body, params } as unknown as AuthenticatedRequest;
}

async function createTestUser(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: 'irrelevant-for-these-tests', emailVerified: true, name: 'Test Owner' },
  });
}

async function createTestBusiness(userId: string, name = 'Escalation Calls Test Biz') {
  const res = mockRes();
  await createBusinessProfile(mockAuthedReq(userId, { name, type: 'Retail' }), res);
  return res.json.mock.calls[0][0];
}

async function createRealCallLog(businessId: string) {
  return prisma.callLog.create({
    data: { businessId, durationSeconds: 0, outcomeTag: 'ANSWERED', transcript: 'placeholder', summary: 'placeholder' },
  });
}

describe('human escalation (Phase 5)', () => {
  beforeEach(() => {
    mockProcessAndSaveCallLog.mockReset();
    mockSendEscalationNotice.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@escalation-calls-test.dev' } } });
    await prisma.callLogOutbox.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('persistCallLog -> escalation detection', () => {
    it('marks the CallLog as needing escalation when Groq analysis tags the call ESCALATED', async () => {
      const user = await createTestUser('detect-1@escalation-calls-test.dev');
      const business = await createTestBusiness(user.id);
      const realLog = await createRealCallLog(business.id);

      mockProcessAndSaveCallLog.mockResolvedValueOnce({
        callLog: realLog,
        analysis: {
          summary: 'Caller wants a refund for a damaged order.',
          outcomeTag: 'ESCALATED',
          unansweredQuestions: ['Can I get a refund for my damaged order?'],
        },
      });

      await persistCallLog({
        callSid: 'CA_escalate_1',
        businessId: business.id,
        customerPhone: '+15551234567',
        transcript: 'Caller: I want a refund.\nAssistant: Let me have someone follow up.',
        durationSeconds: 30,
      });

      const stamped = await prisma.callLog.findUnique({ where: { callSid: 'CA_escalate_1' } });
      expect(stamped?.needsEscalation).toBe(true);
      expect(stamped?.escalationStatus).toBe('PENDING');
      expect(stamped?.escalationReason).toBe('Can I get a refund for my damaged order?');
    });

    it('does not mark escalation for a normally-answered call', async () => {
      const user = await createTestUser('detect-2@escalation-calls-test.dev');
      const business = await createTestBusiness(user.id);
      const realLog = await createRealCallLog(business.id);

      mockProcessAndSaveCallLog.mockResolvedValueOnce({
        callLog: realLog,
        analysis: { summary: 'Caller asked about hours.', outcomeTag: 'ANSWERED', unansweredQuestions: [] },
      });

      await persistCallLog({
        callSid: 'CA_no_escalate_1',
        businessId: business.id,
        customerPhone: '+15551234567',
        transcript: 'Caller: What are your hours?\nAssistant: 9 to 5.',
        durationSeconds: 15,
      });

      const stamped = await prisma.callLog.findUnique({ where: { callSid: 'CA_no_escalate_1' } });
      expect(stamped?.needsEscalation).toBe(false);
      expect(stamped?.escalationStatus).toBe('NONE');
      expect(mockSendEscalationNotice).not.toHaveBeenCalled();
    });

    it('notifies the business owner by email, with only safe fields, when a call is escalated', async () => {
      const user = await createTestUser('notify-1@escalation-calls-test.dev');
      const business = await createTestBusiness(user.id);
      const realLog = await createRealCallLog(business.id);

      mockProcessAndSaveCallLog.mockResolvedValueOnce({
        callLog: realLog,
        analysis: {
          summary: 'Angry customer wants to speak to the manager.',
          outcomeTag: 'ESCALATED',
          unansweredQuestions: ['Can I speak to the manager?'],
        },
      });

      await persistCallLog({
        callSid: 'CA_notify_1',
        businessId: business.id,
        customerPhone: '+15559876543',
        transcript: 'Caller: I want the manager. SYSTEM PROMPT LEAK TEST sk-fake-api-key-123',
        durationSeconds: 45,
      });

      expect(mockSendEscalationNotice).toHaveBeenCalledTimes(1);
      const [toEmail, payload] = mockSendEscalationNotice.mock.calls[0];
      expect(toEmail).toBe('notify-1@escalation-calls-test.dev');
      expect(payload.callerPhone).toBe('+15559876543');
      expect(payload.reason).toBe('Can I speak to the manager?');
      expect(payload.businessName).toBe(business.name);
      // Only the extracted reason/summary is passed — never the raw transcript.
      expect(JSON.stringify(payload)).not.toContain('sk-fake-api-key-123');
      expect(JSON.stringify(payload)).not.toContain('SYSTEM PROMPT LEAK TEST');
    });

    it('still persists the CallLog and escalation even if the notification email fails', async () => {
      const user = await createTestUser('notify-fail@escalation-calls-test.dev');
      const business = await createTestBusiness(user.id);
      const realLog = await createRealCallLog(business.id);

      mockSendEscalationNotice.mockRejectedValueOnce(new Error('SMTP down'));
      mockProcessAndSaveCallLog.mockResolvedValueOnce({
        callLog: realLog,
        analysis: { summary: 'Needs owner.', outcomeTag: 'ESCALATED', unansweredQuestions: [] },
      });

      await expect(
        persistCallLog({
          callSid: 'CA_notify_fail_1',
          businessId: business.id,
          customerPhone: '+15551112222',
          transcript: 'Caller: Help.',
          durationSeconds: 20,
        })
      ).resolves.not.toThrow();

      const stamped = await prisma.callLog.findUnique({ where: { callSid: 'CA_notify_fail_1' } });
      expect(stamped?.needsEscalation).toBe(true);
    });
  });

  describe('GET /calls/escalations (getEscalatedCalls)', () => {
    it('returns only the authenticated owner escalated calls', async () => {
      const ownerA = await createTestUser('list-owner-a@escalation-calls-test.dev');
      const ownerB = await createTestUser('list-owner-b@escalation-calls-test.dev');
      const businessA = await createTestBusiness(ownerA.id, 'Business A');
      const businessB = await createTestBusiness(ownerB.id, 'Business B');

      await prisma.callLog.create({
        data: {
          businessId: businessA.id,
          durationSeconds: 10,
          transcript: 'x',
          summary: 'x',
          needsEscalation: true,
          escalationStatus: 'PENDING',
        },
      });
      await prisma.callLog.create({
        data: {
          businessId: businessB.id,
          durationSeconds: 10,
          transcript: 'x',
          summary: 'x',
          needsEscalation: true,
          escalationStatus: 'PENDING',
        },
      });
      await prisma.callLog.create({
        data: { businessId: businessA.id, durationSeconds: 10, transcript: 'x', summary: 'x' }, // not escalated
      });

      const res = mockRes();
      await getEscalatedCalls(mockAuthedReq(ownerA.id), res);

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveLength(1);
      expect(body[0].businessId).toBe(businessA.id);
    });
  });

  describe('PATCH /calls/:id/escalation (updateEscalationStatus)', () => {
    it('lets the owner mark an escalation as handled', async () => {
      const user = await createTestUser('status-update@escalation-calls-test.dev');
      const business = await createTestBusiness(user.id);
      const call = await prisma.callLog.create({
        data: {
          businessId: business.id,
          durationSeconds: 10,
          transcript: 'x',
          summary: 'x',
          needsEscalation: true,
          escalationStatus: 'PENDING',
        },
      });

      const res = mockRes();
      await updateEscalationStatus(mockAuthedReq(user.id, { escalationStatus: 'HANDLED' }, { id: call.id }), res);

      expect(res.status).not.toHaveBeenCalledWith(404);
      const updated = await prisma.callLog.findUnique({ where: { id: call.id } });
      expect(updated?.escalationStatus).toBe('HANDLED');
    });

    it('rejects an invalid escalationStatus value', async () => {
      const user = await createTestUser('status-invalid@escalation-calls-test.dev');
      const business = await createTestBusiness(user.id);
      const call = await prisma.callLog.create({
        data: { businessId: business.id, durationSeconds: 10, transcript: 'x', summary: 'x', needsEscalation: true },
      });

      const res = mockRes();
      await updateEscalationStatus(mockAuthedReq(user.id, { escalationStatus: 'NOT_A_REAL_STATUS' }, { id: call.id }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a status update for an escalated call belonging to a different business', async () => {
      const owner = await createTestUser('status-owner@escalation-calls-test.dev');
      const attacker = await createTestUser('status-attacker@escalation-calls-test.dev');
      const business = await createTestBusiness(owner.id);
      const call = await prisma.callLog.create({
        data: {
          businessId: business.id,
          durationSeconds: 10,
          transcript: 'x',
          summary: 'x',
          needsEscalation: true,
          escalationStatus: 'PENDING',
        },
      });

      const res = mockRes();
      await updateEscalationStatus(mockAuthedReq(attacker.id, { escalationStatus: 'HANDLED' }, { id: call.id }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      const untouched = await prisma.callLog.findUnique({ where: { id: call.id } });
      expect(untouched?.escalationStatus).toBe('PENDING');
    });
  });
});
