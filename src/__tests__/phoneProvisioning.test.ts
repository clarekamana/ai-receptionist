import { Response } from 'express';

import { createBusinessProfile } from '../controllers/onboarding.controller';
import {
  getAvailableNumbers,
  provisionNumber,
  releaseProvisionedNumber,
} from '../controllers/phoneProvisioning.controller';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { prisma } from '../utils/db';
import * as phoneProvisioningService from '../services/phoneProvisioningService';
import { TwilioNotConfiguredError } from '../services/phoneProvisioningService';

jest.mock('../services/phoneProvisioningService', () => {
  const actual = jest.requireActual('../services/phoneProvisioningService');
  return {
    ...actual,
    searchAvailableNumbers: jest.fn(),
    purchaseNumber: jest.fn(),
    releaseNumber: jest.fn(),
  };
});

const mockSearch = phoneProvisioningService.searchAvailableNumbers as jest.Mock;
const mockPurchase = phoneProvisioningService.purchaseNumber as jest.Mock;
const mockRelease = phoneProvisioningService.releaseNumber as jest.Mock;

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

function mockAuthedReq(userId: string | undefined, body: Record<string, any> = {}, query: Record<string, any> = {}) {
  return { userId, body, query } as unknown as AuthenticatedRequest;
}

async function createTestUser(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: 'irrelevant-for-these-tests', emailVerified: true },
  });
}

async function createTestBusiness(userId: string, name = 'Provisioning Test Biz') {
  const res = mockRes();
  await createBusinessProfile(mockAuthedReq(userId, { name, type: 'Retail' }), res);
  return res.json.mock.calls[0][0];
}

describe('phone number provisioning', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockPurchase.mockReset();
    mockRelease.mockReset();
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@provisioning-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('getAvailableNumbers', () => {
    it('returns numbers from the provisioning service', async () => {
      mockSearch.mockResolvedValueOnce([
        { phoneNumber: '+15005551234', friendlyName: '(500) 555-1234', locality: 'Austin', region: 'TX' },
      ]);

      const res = mockRes();
      await getAvailableNumbers(mockAuthedReq('user-1', {}, { country: 'US' }), res);

      expect(res.json).toHaveBeenCalledWith({
        numbers: [{ phoneNumber: '+15005551234', friendlyName: '(500) 555-1234', locality: 'Austin', region: 'TX' }],
      });
    });

    it('never leaks a raw Twilio error to the client on search failure', async () => {
      mockSearch.mockRejectedValueOnce(new Error('Twilio internal detail: account xyz over quota'));

      const res = mockRes();
      await getAvailableNumbers(mockAuthedReq('user-1', {}, {}), res);

      expect(res.status).toHaveBeenCalledWith(502);
      const body = res.json.mock.calls[0][0];
      expect(JSON.stringify(body)).not.toContain('account xyz');
    });
  });

  describe('provisionNumber', () => {
    it('requires an authenticated user that owns a business (no matching business -> 404)', async () => {
      const res = mockRes();
      await provisionNumber(mockAuthedReq(undefined, { businessId: 'whatever', phoneNumber: '+15005551234' }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockPurchase).not.toHaveBeenCalled();
    });

    it('rejects provisioning a business owned by a different user', async () => {
      const owner = await createTestUser('owner@provisioning-test.dev');
      const attacker = await createTestUser('attacker@provisioning-test.dev');
      const business = await createTestBusiness(owner.id);

      const res = mockRes();
      await provisionNumber(
        mockAuthedReq(attacker.id, { businessId: business.id, phoneNumber: '+15005551234' }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockPurchase).not.toHaveBeenCalled();
    });

    it('provisions a number and persists it on the Business', async () => {
      const user = await createTestUser('success@provisioning-test.dev');
      const business = await createTestBusiness(user.id);

      mockPurchase.mockResolvedValueOnce({ phoneNumber: '+15005551234', sid: 'PNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });

      const res = mockRes();
      await provisionNumber(mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005551234' }), res);

      expect(res.status).toHaveBeenCalledWith(201);
      const updated = await prisma.business.findUnique({ where: { id: business.id } });
      expect(updated?.allocatedPhone).toBe('+15005551234');
      expect(updated?.allocatedPhoneSid).toBe('PNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(updated?.phoneConfigured).toBe(true);
    });

    it('refuses to provision a second number for a business that already has one', async () => {
      const user = await createTestUser('already-has-one@provisioning-test.dev');
      const business = await createTestBusiness(user.id);
      await prisma.business.update({
        where: { id: business.id },
        data: { allocatedPhone: '+15005550000', allocatedPhoneSid: 'PN_existing' },
      });

      const res = mockRes();
      await provisionNumber(mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005551234' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(mockPurchase).not.toHaveBeenCalled();
    });

    it('rejects a concurrent provisioning request for the same business (double-tap protection)', async () => {
      const user = await createTestUser('double-tap@provisioning-test.dev');
      const business = await createTestBusiness(user.id);

      // Never resolves during this test — simulates a slow in-flight purchase.
      mockPurchase.mockImplementationOnce(() => new Promise(() => {}));

      const firstRequest = provisionNumber(
        mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005551234' }),
        mockRes()
      );

      // Give the first request a tick to acquire the lock before the second fires.
      await new Promise((resolve) => setImmediate(resolve));

      const secondRes = mockRes();
      await provisionNumber(mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005555678' }), secondRes);

      expect(secondRes.status).toHaveBeenCalledWith(409);
      expect(mockPurchase).toHaveBeenCalledTimes(1);

      // Not awaiting firstRequest — it deliberately never resolves in this test.
      void firstRequest;
    });

    it('returns a safe error and does not persist anything when Twilio provisioning fails', async () => {
      const user = await createTestUser('twilio-fail@provisioning-test.dev');
      const business = await createTestBusiness(user.id);

      mockPurchase.mockRejectedValueOnce(new Error('Twilio said no, quota exceeded on account ACxxxxx'));

      const res = mockRes();
      await provisionNumber(mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005551234' }), res);

      expect(res.status).toHaveBeenCalledWith(502);
      const body = res.json.mock.calls[0][0];
      expect(JSON.stringify(body)).not.toContain('ACxxxxx');

      const unchanged = await prisma.business.findUnique({ where: { id: business.id } });
      expect(unchanged?.allocatedPhoneSid).toBeNull();
    });

    it('does not leak configuration details when Twilio is not configured', async () => {
      const user = await createTestUser('not-configured@provisioning-test.dev');
      const business = await createTestBusiness(user.id);

      mockPurchase.mockRejectedValueOnce(new TwilioNotConfiguredError());

      const res = mockRes();
      await provisionNumber(mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005551234' }), res);

      expect(res.status).toHaveBeenCalledWith(502);
      const body = res.json.mock.calls[0][0];
      expect(JSON.stringify(body).toLowerCase()).not.toContain('twilio_auth_token');
    });

    it('allows a new provisioning attempt after the previous one finished', async () => {
      const user = await createTestUser('after-finish@provisioning-test.dev');
      const business = await createTestBusiness(user.id);

      mockPurchase.mockRejectedValueOnce(new Error('transient failure'));
      await provisionNumber(mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005551234' }), mockRes());

      mockPurchase.mockResolvedValueOnce({ phoneNumber: '+15005551234', sid: 'PN_retry' });
      const res = mockRes();
      await provisionNumber(mockAuthedReq(user.id, { businessId: business.id, phoneNumber: '+15005551234' }), res);

      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('releaseProvisionedNumber', () => {
    it('releases a real provisioned number and clears the Business fields', async () => {
      const user = await createTestUser('release@provisioning-test.dev');
      const business = await createTestBusiness(user.id);
      await prisma.business.update({
        where: { id: business.id },
        data: { allocatedPhone: '+15005551234', allocatedPhoneSid: 'PN_to_release', phoneConfigured: true },
      });

      mockRelease.mockResolvedValueOnce(undefined);

      const res = mockRes();
      await releaseProvisionedNumber(mockAuthedReq(user.id, { businessId: business.id }), res);

      expect(res.status).not.toHaveBeenCalledWith(502);
      expect(mockRelease).toHaveBeenCalledWith('PN_to_release');

      const updated = await prisma.business.findUnique({ where: { id: business.id } });
      expect(updated?.allocatedPhone).toBeNull();
      expect(updated?.allocatedPhoneSid).toBeNull();
      expect(updated?.phoneConfigured).toBe(false);
    });

    it('refuses to release a business with no real provisioned number', async () => {
      const user = await createTestUser('nothing-to-release@provisioning-test.dev');
      const business = await createTestBusiness(user.id);

      const res = mockRes();
      await releaseProvisionedNumber(mockAuthedReq(user.id, { businessId: business.id }), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it('rejects releasing a number for a business owned by a different user', async () => {
      const owner = await createTestUser('release-owner@provisioning-test.dev');
      const attacker = await createTestUser('release-attacker@provisioning-test.dev');
      const business = await createTestBusiness(owner.id);
      await prisma.business.update({
        where: { id: business.id },
        data: { allocatedPhone: '+15005551234', allocatedPhoneSid: 'PN_protected' },
      });

      const res = mockRes();
      await releaseProvisionedNumber(mockAuthedReq(attacker.id, { businessId: business.id }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });
});
