import { Response } from 'express';

import { createBusinessProfile } from '../controllers/onboarding.controller';
import { updateBusinessProfile, addTeamMember } from '../controllers/settings.controller';
import { getTodayDashboard } from '../controllers/dashboard.controller';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
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

async function createTestBusiness(userId: string, name = 'Contract Test Biz') {
  const res = mockRes();
  await createBusinessProfile(mockReq(userId, { name, type: 'Retail' }), res);
  return res.json.mock.calls[0][0];
}

describe('Phase 3 contract cleanup regressions', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@contract-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('settings.updateBusinessProfile ownership (was previously unchecked)', () => {
    it('updates the business when the caller owns it', async () => {
      const user = await createTestUser('owner-update@contract-test.dev');
      const business = await createTestBusiness(user.id);

      const res = mockRes();
      await updateBusinessProfile(
        mockReq(user.id, { businessId: business.id, name: 'Renamed Biz', type: 'Retail' }),
        res
      );

      expect(res.status).not.toHaveBeenCalledWith(404);
      const updated = await prisma.business.findUnique({ where: { id: business.id } });
      expect(updated?.name).toBe('Renamed Biz');
    });

    it('rejects updating a business owned by a different user', async () => {
      const owner = await createTestUser('real-owner@contract-test.dev');
      const attacker = await createTestUser('attacker@contract-test.dev');
      const business = await createTestBusiness(owner.id);

      const res = mockRes();
      await updateBusinessProfile(
        mockReq(attacker.id, { businessId: business.id, name: 'Hijacked', type: 'Retail' }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(404);
      const untouched = await prisma.business.findUnique({ where: { id: business.id } });
      expect(untouched?.name).not.toBe('Hijacked');
    });

    it('rejects a missing businessId', async () => {
      const user = await createTestUser('missing-id@contract-test.dev');
      const res = mockRes();

      await updateBusinessProfile(mockReq(user.id, { name: 'x', type: 'y' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('settings.addTeamMember ownership (was previously unchecked)', () => {
    it('rejects adding a team member to a business owned by a different user', async () => {
      const owner = await createTestUser('team-owner@contract-test.dev');
      const attacker = await createTestUser('team-attacker@contract-test.dev');
      const business = await createTestBusiness(owner.id);

      const res = mockRes();
      await addTeamMember(
        mockReq(attacker.id, { businessId: business.id, name: 'Intruder', email: 'x@y.com' }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(404);
      const members = await prisma.teamMember.findMany({ where: { businessId: business.id } });
      expect(members).toHaveLength(0);
    });
  });

  describe('dashboard response shape (mobile client depends on these exact field names)', () => {
    it('returns todayCallsCount, pendingQuestionsCount and upcomingAppointments', async () => {
      const user = await createTestUser('dashboard-shape@contract-test.dev');
      await createTestBusiness(user.id);

      const res = mockRes();
      await getTodayDashboard(mockReq(user.id), res);

      expect(res.status).not.toHaveBeenCalledWith(404);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('todayCallsCount');
      expect(body).toHaveProperty('pendingQuestionsCount');
      expect(body).toHaveProperty('upcomingAppointments');
      expect(Array.isArray(body.upcomingAppointments)).toBe(true);
    });
  });
});
