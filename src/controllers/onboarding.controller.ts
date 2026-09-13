import { Response } from 'express';
import { randomInt } from 'crypto';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

// Minimal shape check, not carrier/country validation: digits (with optional
// leading +, spaces, dashes, parentheses) and a plausible digit count. There
// is no existing phone-normalization utility in this codebase to reuse, so
// the value is only validated and trimmed, never reformatted.
const isValidForwardingPhone = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/^\+?[0-9()\-\s]+$/.test(trimmed)) return false;
  const digitCount = trimmed.replace(/[^0-9]/g, '').length;
  return digitCount >= 7 && digitCount <= 15;
};

// Mock "new number" provisioning only — real carrier provisioning is a later
// phase. Business.allocatedPhone is @unique (Phase 4A), so this can no
// longer hand every business the same literal number; a random suffix
// avoids collisions for this mock without pretending to be a real
// provider-issued number.
const generateMockAllocatedPhone = () => `+1800555${String(randomInt(0, 10000)).padStart(4, '0')}`;

export const createBusinessProfile = async (req: AuthenticatedRequest, res: Response) => {
  const { name, type, timezone, hoursAndServices } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'Business name and type are required' });
  }

  // Idempotent: an authenticated user has at most one Business. If onboarding
  // is resumed (app reload, revisited step), reuse and update it instead of
  // creating a duplicate.
  const existing = await prisma.business.findFirst({ where: { ownerId: req.userId } });

  if (existing) {
    const updated = await prisma.business.update({
      where: { id: existing.id },
      data: {
        name,
        type,
        timezone: timezone || existing.timezone,
        ...(hoursAndServices !== undefined ? { hoursAndServices: JSON.stringify(hoursAndServices) } : {}),
      },
    });
    return res.status(200).json(updated);
  }

  const business = await prisma.business.create({
    data: {
      ownerId: req.userId!,
      name,
      type,
      timezone: timezone || 'UTC',
      ...(hoursAndServices !== undefined ? { hoursAndServices: JSON.stringify(hoursAndServices) } : {}),
      onboardingState: { create: { currentStep: 1 } },
      notificationSetting: { create: {} }
    }
  });

  return res.status(201).json(business);
};

export const updateOnboardingStep = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, step, stepData, completed } = req.body;

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required' });
  }

  const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const state = await prisma.onboardingState.upsert({
    where: { businessId },
    update: {
      currentStep: step,
      stepData: JSON.stringify(stepData),
      completed: completed || false
    },
    create: {
      businessId,
      currentStep: step,
      stepData: JSON.stringify(stepData),
      completed: completed || false
    }
  });

  return res.json({ message: 'Onboarding step saved', state });
};

export const setupPhoneNumber = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, mode, forwardingPhone } = req.body; // mode: "NEW" | "FORWARD"

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required' });
  }

  const existing = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!existing) {
    return res.status(404).json({ error: 'Business not found' });
  }

  if (mode !== 'NEW' && mode !== 'FORWARD') {
    return res.status(400).json({ error: 'mode must be "NEW" or "FORWARD"' });
  }

  if (mode === 'FORWARD' && !isValidForwardingPhone(forwardingPhone)) {
    return res.status(400).json({ error: 'A valid forwarding phone number is required.' });
  }

  // Idempotent: only mint a new mock number the first time a business picks
  // "NEW" mode. Resubmitting the same step (revisited onboarding, reload)
  // must not keep reassigning a different random number.
  const allocatedPhone =
    mode === 'NEW' ? existing.allocatedPhone || generateMockAllocatedPhone() : existing.allocatedPhone;

  let business;
  try {
    business = await prisma.business.update({
      where: { id: businessId },
      data: {
        allocatedPhone,
        forwardingPhone: mode === 'FORWARD' ? forwardingPhone.trim() : forwardingPhone,
        phoneConfigured: true
      }
    });
  } catch (err: any) {
    // Extremely unlikely random-suffix collision against another business's
    // mock number — fail cleanly instead of a generic 500.
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Could not assign a mock number right now. Please try again.' });
    }
    throw err;
  }

  return res.json({
    message: 'Phone routing configured successfully',
    mock: true,
    instructions: mode === 'FORWARD' ? `Dial *21*${allocatedPhone || '+18005550199'}# on your phone.` : 'Your AI number is ready.',
    business
  });
};
