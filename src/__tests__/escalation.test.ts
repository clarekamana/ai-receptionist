import { Response } from 'express';

import { createBusinessProfile, updateOnboardingStep, setupPhoneNumber } from '../controllers/onboarding.controller';
import { syncEscalationRules } from '../controllers/escalation.controller';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { buildSystemPrompt } from '../services/aiCallService';
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

async function createTestBusiness(userId: string, name = 'Escalation Test Biz') {
  const res = mockRes();
  await createBusinessProfile(mockReq(userId, { name, type: 'Salon' }), res);
  return res.json.mock.calls[0][0];
}

const ONBOARDING_RULES = [
  { topic: 'Pricing exceptions', description: 'Discount requests.', enabled: false },
  { topic: 'Complaints', description: 'Frustration or anger detected.', enabled: true },
  { topic: 'Cancellations', description: 'Active booking cancelled.', enabled: true },
  { topic: 'VIP Clients', description: 'Starred contacts.', enabled: false },
];

describe('escalation rules + AI prompt integration', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@escalation-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates escalation rules for the authenticated owner, scoped to their Business', async () => {
    const user = await createTestUser('create-rules@escalation-test.dev');
    const business = await createTestBusiness(user.id);

    const res = mockRes();
    await syncEscalationRules(mockReq(user.id, { businessId: business.id, rules: ONBOARDING_RULES }), res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.status).not.toHaveBeenCalledWith(400);

    const rules = await prisma.escalationRule.findMany({ where: { businessId: business.id } });
    expect(rules).toHaveLength(4);
    expect(rules.every((r) => r.businessId === business.id)).toBe(true);
  });

  it('rejects configuring escalation rules on a Business owned by a different user', async () => {
    const owner = await createTestUser('owner@escalation-test.dev');
    const attacker = await createTestUser('attacker@escalation-test.dev');
    const business = await createTestBusiness(owner.id);

    const res = mockRes();
    await syncEscalationRules(
      mockReq(attacker.id, { businessId: business.id, rules: ONBOARDING_RULES }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(404);
    const rules = await prisma.escalationRule.findMany({ where: { businessId: business.id } });
    expect(rules).toHaveLength(0);
  });

  it('does not duplicate rules when the same selections are resubmitted', async () => {
    const user = await createTestUser('no-dup-rules@escalation-test.dev');
    const business = await createTestBusiness(user.id);

    await syncEscalationRules(mockReq(user.id, { businessId: business.id, rules: ONBOARDING_RULES }), mockRes());
    await syncEscalationRules(mockReq(user.id, { businessId: business.id, rules: ONBOARDING_RULES }), mockRes());

    const rules = await prisma.escalationRule.findMany({ where: { businessId: business.id } });
    expect(rules).toHaveLength(4);
  });

  it('turning a rule off disables it (askOwner: false) instead of leaving stale duplicates', async () => {
    const user = await createTestUser('toggle-off@escalation-test.dev');
    const business = await createTestBusiness(user.id);

    await syncEscalationRules(mockReq(user.id, { businessId: business.id, rules: ONBOARDING_RULES }), mockRes());

    const turnedOff = ONBOARDING_RULES.map((rule) =>
      rule.topic === 'Complaints' ? { ...rule, enabled: false } : rule
    );
    await syncEscalationRules(mockReq(user.id, { businessId: business.id, rules: turnedOff }), mockRes());

    const rules = await prisma.escalationRule.findMany({ where: { businessId: business.id } });
    expect(rules).toHaveLength(4);

    const complaints = rules.find((r) => r.topic === 'Complaints');
    expect(complaints?.askOwner).toBe(false);
  });

  it('is readable through the same Business query buildSystemPrompt uses', async () => {
    const user = await createTestUser('readable@escalation-test.dev');
    const business = await createTestBusiness(user.id);

    await syncEscalationRules(mockReq(user.id, { businessId: business.id, rules: ONBOARDING_RULES }), mockRes());

    const withRules = await prisma.business.findUnique({
      where: { id: business.id },
      include: { escalationRules: true },
    });

    expect(withRules?.escalationRules.length).toBe(4);
  });

  it('feeds enabled escalation rules into the AI system prompt, and excludes disabled ones', async () => {
    const user = await createTestUser('prompt-integration@escalation-test.dev');
    const business = await createTestBusiness(user.id);

    await syncEscalationRules(mockReq(user.id, { businessId: business.id, rules: ONBOARDING_RULES }), mockRes());

    const prompt = await buildSystemPrompt(business.id);

    // Enabled selections must influence the AI's instructions...
    expect(prompt).toContain('Complaints');
    expect(prompt).toContain('Cancellations');

    // ...disabled ones must not.
    expect(prompt).not.toContain('Pricing exceptions');
    expect(prompt).not.toContain('VIP Clients');
  });

  describe('FAQ skip / onboarding progress', () => {
    it('records onboarding progress for step 2 even with zero FAQs (the "skip" path)', async () => {
      const user = await createTestUser('faq-skip@escalation-test.dev');
      const business = await createTestBusiness(user.id);

      const res = mockRes();
      await updateOnboardingStep(
        mockReq(user.id, { businessId: business.id, step: 2, stepData: { faqCount: 0 } }),
        res
      );

      expect(res.status).not.toHaveBeenCalledWith(404);
      const state = await prisma.onboardingState.findUnique({ where: { businessId: business.id } });
      expect(state?.currentStep).toBe(2);
      expect(JSON.parse(state!.stepData!)).toEqual({ faqCount: 0 });

      const faqs = await prisma.knowledgeItem.findMany({ where: { businessId: business.id } });
      expect(faqs).toHaveLength(0);
    });
  });

  describe('forwarding phone number validation', () => {
    it('rejects an empty forwarding number', async () => {
      const user = await createTestUser('empty-phone@escalation-test.dev');
      const business = await createTestBusiness(user.id);

      const res = mockRes();
      await setupPhoneNumber(mockReq(user.id, { businessId: business.id, mode: 'FORWARD', forwardingPhone: '' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a clearly invalid forwarding number', async () => {
      const user = await createTestUser('invalid-phone@escalation-test.dev');
      const business = await createTestBusiness(user.id);

      const res = mockRes();
      await setupPhoneNumber(
        mockReq(user.id, { businessId: business.id, mode: 'FORWARD', forwardingPhone: 'call-me-maybe' }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('accepts a valid forwarding number and persists it', async () => {
      const user = await createTestUser('valid-phone@escalation-test.dev');
      const business = await createTestBusiness(user.id);

      const res = mockRes();
      await setupPhoneNumber(
        mockReq(user.id, { businessId: business.id, mode: 'FORWARD', forwardingPhone: '+1 (555) 019-8000' }),
        res
      );

      expect(res.status).not.toHaveBeenCalledWith(400);
      const updated = await prisma.business.findUnique({ where: { id: business.id } });
      expect(updated?.forwardingPhone).toBe('+1 (555) 019-8000');
      expect(updated?.phoneConfigured).toBe(true);
    });
  });
});
