import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getAccountAndBusiness = async (req: AuthenticatedRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, phone: true, name: true, phoneVerified: true }
  });

  const business = await prisma.business.findFirst({
    where: { ownerId: req.userId },
    include: { teamMembers: true, onboardingState: true }
  });

  return res.json({ user, business });
};

export const updateBusinessProfile = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, name, type, hoursAndServices } = req.body;

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required' });
  }

  const existing = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!existing) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const business = await prisma.business.update({
    where: { id: businessId },
    data: {
      name,
      type,
      ...(hoursAndServices !== undefined ? { hoursAndServices: JSON.stringify(hoursAndServices) } : {}),
    }
  });

  return res.json(business);
};

export const addTeamMember = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, name, email, role } = req.body;

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required' });
  }

  const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const member = await prisma.teamMember.create({
    data: { businessId, name, email, role: role || 'MEMBER' }
  });

  return res.status(201).json(member);
};