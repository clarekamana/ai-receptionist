import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { ENV } from '../config/env';
import {
  searchAvailableNumbers,
  purchaseNumber,
  releaseNumber,
  beginProvisioning,
  endProvisioning,
  TwilioNotConfiguredError,
} from '../services/phoneProvisioningService';

/** Never let a raw Twilio SDK error (which can include request/response detail) reach the client. */
function safeProvisioningError(error: unknown): string {
  if (error instanceof TwilioNotConfiguredError) {
    return 'Phone provisioning is not available right now. Please try again later.';
  }
  return 'Could not complete that phone number request. Please try again.';
}

export const getAvailableNumbers = async (req: AuthenticatedRequest, res: Response) => {
  const country = typeof req.query.country === 'string' ? req.query.country : 'US';
  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 10;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : 10;

  try {
    const numbers = await searchAvailableNumbers(country, limit);
    return res.json({ numbers });
  } catch (error) {
    console.error('[telephony] Number search failed.', {
      errorCategory: error instanceof Error ? error.name || 'Error' : 'UnknownError',
    });
    return res.status(502).json({ error: safeProvisioningError(error) });
  }
};

export const provisionNumber = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, phoneNumber } = req.body;

  if (!businessId || !phoneNumber) {
    return res.status(400).json({ error: 'businessId and phoneNumber are required' });
  }

  const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  if (business.allocatedPhoneSid) {
    // Already has a real provisioned number — release it first via the
    // dedicated endpoint rather than silently replacing it here.
    return res.status(409).json({ error: 'This business already has a provisioned number.' });
  }

  if (!ENV.PUBLIC_BASE_URL) {
    console.error('[telephony] Provisioning attempted without PUBLIC_BASE_URL configured.');
    return res.status(500).json({ error: 'Phone provisioning is not configured on this server.' });
  }

  // Server-side guard against a double-tap/double-submit purchasing two
  // numbers for the same business before the first request finishes.
  if (!beginProvisioning(businessId)) {
    return res.status(409).json({ error: 'A number request for this business is already in progress.' });
  }

  try {
    // Re-check inside the lock in case another request completed between
    // the check above and acquiring the lock.
    const current = await prisma.business.findUnique({ where: { id: businessId } });
    if (current?.allocatedPhoneSid) {
      return res.status(409).json({ error: 'This business already has a provisioned number.' });
    }

    const purchased = await purchaseNumber(phoneNumber, ENV.PUBLIC_BASE_URL);

    const updated = await prisma.business.update({
      where: { id: businessId },
      data: {
        allocatedPhone: purchased.phoneNumber,
        allocatedPhoneSid: purchased.sid,
        phoneConfigured: true,
      },
    });

    return res.status(201).json({ message: 'Phone number provisioned.', business: updated });
  } catch (error) {
    console.error('[telephony] Number provisioning failed.', {
      businessId,
      errorCategory: error instanceof Error ? error.name || 'Error' : 'UnknownError',
    });
    return res.status(502).json({ error: safeProvisioningError(error) });
  } finally {
    endProvisioning(businessId);
  }
};

export const releaseProvisionedNumber = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId } = req.body;

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required' });
  }

  const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  if (!business.allocatedPhoneSid) {
    return res.status(409).json({ error: 'This business does not have a provisioned number to release.' });
  }

  try {
    await releaseNumber(business.allocatedPhoneSid);

    const updated = await prisma.business.update({
      where: { id: businessId },
      data: { allocatedPhone: null, allocatedPhoneSid: null, phoneConfigured: false },
    });

    return res.json({ message: 'Phone number released.', business: updated });
  } catch (error) {
    console.error('[telephony] Number release failed.', {
      businessId,
      errorCategory: error instanceof Error ? error.name || 'Error' : 'UnknownError',
    });
    return res.status(502).json({ error: safeProvisioningError(error) });
  }
};
