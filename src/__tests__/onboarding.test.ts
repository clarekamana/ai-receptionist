import { Response } from 'express';

import { createBusinessProfile, updateOnboardingStep } from '../controllers/onboarding.controller';
import { addKnowledgeItem } from '../controllers/knowledge.controller';
import { authenticate, AuthenticatedRequest } from '../middlewares/auth.middleware';
import { generateToken } from '../utils/jwt';
import { prisma } from '../utils/db';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

function mockReq(userId: string | undefined, body: Record<string, any> = {}) {
  return { userId, body } as AuthenticatedRequest;
}

async function createTestUser(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: 'irrelevant-for-these-tests', emailVerified: true },
  });
}

describe('onboarding + knowledge controllers', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@onboarding-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('createBusinessProfile', () => {
    it('creates a Business owned by the authenticated user', async () => {
      const user = await createTestUser('create-business@onboarding-test.dev');
      const req = mockReq(user.id, { name: 'Glow Salon', type: 'Salon & Spa' });
      const res = mockRes();

      await createBusinessProfile(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0];
      expect(body.ownerId).toBe(user.id);

      const businesses = await prisma.business.findMany({ where: { ownerId: user.id } });
      expect(businesses).toHaveLength(1);
      expect(businesses[0].name).toBe('Glow Salon');
    });

    it('does not create a duplicate Business on a second submission, and updates the existing one', async () => {
      const user = await createTestUser('no-dup@onboarding-test.dev');

      await createBusinessProfile(mockReq(user.id, { name: 'First Name', type: 'Salon' }), mockRes());

      const res2 = mockRes();
      await createBusinessProfile(mockReq(user.id, { name: 'Updated Name', type: 'Salon' }), res2);

      expect(res2.status).toHaveBeenCalledWith(200);

      const businesses = await prisma.business.findMany({ where: { ownerId: user.id } });
      expect(businesses).toHaveLength(1);
      expect(businesses[0].name).toBe('Updated Name');
    });

    it('rejects requests missing required fields', async () => {
      const user = await createTestUser('missing-fields@onboarding-test.dev');
      const res = mockRes();

      await createBusinessProfile(mockReq(user.id, { name: '' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      const businesses = await prisma.business.findMany({ where: { ownerId: user.id } });
      expect(businesses).toHaveLength(0);
    });
  });

  describe('knowledge base ownership', () => {
    it('associates a FAQ with the correct Business', async () => {
      const user = await createTestUser('faq-owner@onboarding-test.dev');
      const createRes = mockRes();
      await createBusinessProfile(mockReq(user.id, { name: 'FAQ Biz', type: 'Retail' }), createRes);
      const business = createRes.json.mock.calls[0][0];

      const faqRes = mockRes();
      await addKnowledgeItem(
        mockReq(user.id, { businessId: business.id, question: 'Open Sundays?', answer: 'No.' }),
        faqRes
      );

      expect(faqRes.status).toHaveBeenCalledWith(201);
      const item = faqRes.json.mock.calls[0][0];
      expect(item.businessId).toBe(business.id);
    });

    it('rejects writing a FAQ to a Business owned by a different user', async () => {
      const owner = await createTestUser('real-owner@onboarding-test.dev');
      const attacker = await createTestUser('attacker@onboarding-test.dev');

      const createRes = mockRes();
      await createBusinessProfile(mockReq(owner.id, { name: 'Victim Biz', type: 'Retail' }), createRes);
      const business = createRes.json.mock.calls[0][0];

      const faqRes = mockRes();
      await addKnowledgeItem(
        mockReq(attacker.id, { businessId: business.id, question: 'x', answer: 'y' }),
        faqRes
      );

      expect(faqRes.status).toHaveBeenCalledWith(404);
    });

    it('rejects a non-existent businessId cleanly', async () => {
      const user = await createTestUser('missing-business@onboarding-test.dev');
      const res = mockRes();

      await addKnowledgeItem(
        mockReq(user.id, { businessId: 'does-not-exist', question: 'x', answer: 'y' }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('updateOnboardingStep (escalation rules persistence)', () => {
    it('persists escalation rule selections against the correct Business', async () => {
      const user = await createTestUser('escalation@onboarding-test.dev');
      const createRes = mockRes();
      await createBusinessProfile(mockReq(user.id, { name: 'Escalation Biz', type: 'Salon' }), createRes);
      const business = createRes.json.mock.calls[0][0];

      const escalationRules = { pricing: false, complaints: true, cancellations: true, vip: false };

      const stepRes = mockRes();
      await updateOnboardingStep(
        mockReq(user.id, { businessId: business.id, step: 3, stepData: { escalationRules } }),
        stepRes
      );

      expect(stepRes.status).not.toHaveBeenCalledWith(404);

      const state = await prisma.onboardingState.findUnique({ where: { businessId: business.id } });
      expect(state).not.toBeNull();
      expect(JSON.parse(state!.stepData!)).toEqual({ escalationRules });
      expect(state!.currentStep).toBe(3);
    });

    it('rejects a step update against a Business the user does not own', async () => {
      const owner = await createTestUser('step-owner@onboarding-test.dev');
      const attacker = await createTestUser('step-attacker@onboarding-test.dev');

      const createRes = mockRes();
      await createBusinessProfile(mockReq(owner.id, { name: 'Step Biz', type: 'Salon' }), createRes);
      const business = createRes.json.mock.calls[0][0];

      const res = mockRes();
      await updateOnboardingStep(
        mockReq(attacker.id, { businessId: business.id, step: 3, stepData: {} }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('authenticate middleware', () => {
    it('rejects requests with no Authorization header', () => {
      const req = { headers: {} } as AuthenticatedRequest;
      const res = mockRes();
      const next = jest.fn();

      authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects an invalid/garbage token', () => {
      const req = { headers: { authorization: 'Bearer not-a-real-token' } } as AuthenticatedRequest;
      const res = mockRes();
      const next = jest.fn();

      authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts a valid token and attaches userId', () => {
      const token = generateToken({ userId: 'some-user-id' });
      const req = { headers: { authorization: `Bearer ${token}` } } as AuthenticatedRequest;
      const res = mockRes();
      const next = jest.fn();

      authenticate(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.userId).toBe('some-user-id');
    });
  });
});
