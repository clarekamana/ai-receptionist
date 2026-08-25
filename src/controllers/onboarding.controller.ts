import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const createBusinessProfile = async (req: AuthenticatedRequest, res: Response) => {
  const { name, type, timezone } = req.body;

  const business = await prisma.business.create({
    data: {
      ownerId: req.userId!,
      name,
      type,
      timezone: timezone || 'UTC',
      onboardingState: { create: { currentStep: 1 } },
      notificationSetting: { create: {} }
    }
  });

  return res.status(201).json(business);
};

export const updateOnboardingStep = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, step, stepData, completed } = req.body;

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

  const allocatedPhone = mode === 'NEW' ? '+18005550199' : null;

  const business = await prisma.business.update({
    where: { id: businessId },
    data: {
      allocatedPhone: allocatedPhone || businessId,
      forwardingPhone,
      phoneConfigured: true
    }
  });

  return res.json({
    message: 'Phone routing configured successfully',
    instructions: mode === 'FORWARD' ? `Dial *21*${allocatedPhone || '+18005550199'}# on your phone.` : 'Your AI number is ready.',
    business
  });
};