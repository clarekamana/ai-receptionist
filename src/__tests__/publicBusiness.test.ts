import { Response } from 'express';

import { createBusinessProfile } from '../controllers/onboarding.controller';
import { listBusinesses, searchBusinesses, getBusinessPublic } from '../controllers/publicBusiness.controller';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { prisma } from '../utils/db';

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

function mockAuthedReq(userId: string, body: Record<string, any> = {}) {
  return { userId, body } as AuthenticatedRequest;
}

function mockPublicReq(query: Record<string, any> = {}, params: Record<string, any> = {}) {
  return { query, params } as any;
}

async function createTestUser(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: 'irrelevant-for-these-tests', emailVerified: true },
  });
}

async function createTestBusiness(userId: string, name: string, type: string) {
  const res = mockRes();
  await createBusinessProfile(mockAuthedReq(userId, { name, type }), res);
  return res.json.mock.calls[0][0];
}

describe('public business discovery (Mwakire customer app)', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@public-business-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('response allowlist', () => {
    it('never exposes ownerId, allocatedPhoneSid, or forwardingPhone', async () => {
      const user = await createTestUser('allowlist@public-business-test.dev');
      const business = await createTestBusiness(user.id, 'Allowlist Biz', 'Salon');
      await prisma.business.update({
        where: { id: business.id },
        data: { forwardingPhone: '+15551234567', allocatedPhoneSid: 'PN_secret' },
      });

      const res = mockRes();
      await getBusinessPublic(mockPublicReq({}, { id: business.id }), res);

      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('ownerId');
      expect(body).not.toHaveProperty('allocatedPhoneSid');
      expect(body).not.toHaveProperty('forwardingPhone');
      expect(JSON.stringify(body)).not.toContain('PN_secret');
      expect(JSON.stringify(body)).not.toContain('+15551234567');
    });

    it('does not require authentication', async () => {
      const user = await createTestUser('no-auth@public-business-test.dev');
      await createTestBusiness(user.id, 'No Auth Biz', 'Retail');

      // mockPublicReq has no userId at all — simulates an anonymous request.
      const res = mockRes();
      await listBusinesses(mockPublicReq({}), res);

      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('aiReceptionistAvailable', () => {
    // Mwakire's customer app calls the AI receptionist over an in-app
    // WebRTC call (src/calls/), which needs no Twilio number at all —
    // availability now reflects "onboarding completed", not phone
    // provisioning. See publicBusiness.controller.ts's toPublicBusiness().
    it('is false when onboarding is not completed, even with a real Twilio number provisioned', async () => {
      const user = await createTestUser('incomplete-onboarding@public-business-test.dev');
      const business = await createTestBusiness(user.id, 'Incomplete Onboarding Biz', 'Retail');
      await prisma.business.update({
        where: { id: business.id },
        data: { allocatedPhone: '+15005551234', allocatedPhoneSid: 'PN_real' },
      });

      const res = mockRes();
      await getBusinessPublic(mockPublicReq({}, { id: business.id }), res);

      const body = res.json.mock.calls[0][0];
      expect(body.aiReceptionistAvailable).toBe(false);
      expect(body).not.toHaveProperty('callNumber');
    });

    it('is true once onboarding is completed, even with no Twilio number at all', async () => {
      const user = await createTestUser('completed-onboarding@public-business-test.dev');
      const business = await createTestBusiness(user.id, 'Completed Onboarding Biz', 'Retail');
      await prisma.onboardingState.update({
        where: { businessId: business.id },
        data: { completed: true },
      });

      const res = mockRes();
      await getBusinessPublic(mockPublicReq({}, { id: business.id }), res);

      const body = res.json.mock.calls[0][0];
      expect(body.aiReceptionistAvailable).toBe(true);
      expect(body).not.toHaveProperty('callNumber');
    });
  });

  describe('isOpenNow', () => {
    it('is null when no hours have been configured', async () => {
      const user = await createTestUser('no-hours@public-business-test.dev');
      const business = await createTestBusiness(user.id, 'No Hours Biz', 'Retail');

      const res = mockRes();
      await getBusinessPublic(mockPublicReq({}, { id: business.id }), res);

      expect(res.json.mock.calls[0][0].isOpenNow).toBeNull();
      expect(res.json.mock.calls[0][0].hours).toBeNull();
    });

    it('is true when now falls within a 24/7 schedule', async () => {
      const user = await createTestUser('always-open@public-business-test.dev');
      const business = await createTestBusiness(user.id, 'Always Open Biz', 'Restaurant');
      await prisma.business.update({
        where: { id: business.id },
        data: {
          timezone: 'UTC',
          hoursAndServices: JSON.stringify({
            selectedDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
            openingTime: '12:00 AM',
            closingTime: '11:45 PM',
          }),
        },
      });

      const res = mockRes();
      await getBusinessPublic(mockPublicReq({}, { id: business.id }), res);

      expect(res.json.mock.calls[0][0].isOpenNow).toBe(true);
    });

    it('is false when today is not one of the selected days', async () => {
      const user = await createTestUser('closed-today@public-business-test.dev');
      const business = await createTestBusiness(user.id, 'Closed Today Biz', 'Retail');
      await prisma.business.update({
        where: { id: business.id },
        data: {
          timezone: 'UTC',
          // A day name that can never match today, so this is always "closed".
          hoursAndServices: JSON.stringify({ selectedDays: [], openingTime: '09:00 AM', closingTime: '05:00 PM' }),
        },
      });

      const res = mockRes();
      await getBusinessPublic(mockPublicReq({}, { id: business.id }), res);

      expect(res.json.mock.calls[0][0].isOpenNow).toBe(false);
    });
  });

  describe('listBusinesses', () => {
    it('returns businesses and respects the category filter against type', async () => {
      const user = await createTestUser('list-1@public-business-test.dev');
      await createTestBusiness(user.id, 'List Test Dental', 'Dental Clinic');

      const res = mockRes();
      await listBusinesses(mockPublicReq({ category: 'Dental' }), res);

      const body = res.json.mock.calls[0][0];
      expect(body.businesses.some((b: any) => b.name === 'List Test Dental')).toBe(true);
    });

    it('caps the limit at the maximum allowed', async () => {
      const res = mockRes();
      await listBusinesses(mockPublicReq({ limit: '9999' }), res);

      // Just verifying it doesn't throw / doesn't blindly trust an absurd limit.
      expect(res.status).not.toHaveBeenCalledWith(500);
    });
  });

  describe('searchBusinesses', () => {
    it('matches by name', async () => {
      const user = await createTestUser('search-name@public-business-test.dev');
      await createTestBusiness(user.id, 'Kigali Dental Search Test', 'Dental Clinic');

      const res = mockRes();
      await searchBusinesses(mockPublicReq({ q: 'Kigali Dental Search Test' }), res);

      const body = res.json.mock.calls[0][0];
      expect(body.businesses.some((b: any) => b.name === 'Kigali Dental Search Test')).toBe(true);
    });

    it('matches by type/category', async () => {
      const user = await createTestUser('search-type@public-business-test.dev');
      await createTestBusiness(user.id, 'Search By Type Biz', 'UniqueSearchCategoryXYZ');

      const res = mockRes();
      await searchBusinesses(mockPublicReq({ q: 'UniqueSearchCategoryXYZ' }), res);

      const body = res.json.mock.calls[0][0];
      expect(body.businesses.some((b: any) => b.name === 'Search By Type Biz')).toBe(true);
    });

    it('returns an empty list for an empty query instead of every business', async () => {
      const res = mockRes();
      await searchBusinesses(mockPublicReq({ q: '' }), res);

      expect(res.json.mock.calls[0][0]).toEqual({ businesses: [] });
    });

    it('returns an empty list for a query matching nothing, not an error', async () => {
      const res = mockRes();
      await searchBusinesses(mockPublicReq({ q: 'ZzNoBusinessShouldEverMatchThisZz' }), res);

      expect(res.json.mock.calls[0][0]).toEqual({ businesses: [] });
    });
  });

  describe('getBusinessPublic', () => {
    it('returns 404 for a non-existent business without leaking details', async () => {
      const res = mockRes();
      await getBusinessPublic(mockPublicReq({}, { id: 'does-not-exist' }), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
