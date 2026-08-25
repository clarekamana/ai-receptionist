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
    include: { teamMembers: true }
  });

  return res.json({ user, business });
};

export const updateBusinessProfile = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, name, type, hoursAndServices } = req.body;

  const business = await prisma.business.update({
    where: { id: businessId },
    data: { name, type, hoursAndServices: JSON.stringify(hoursAndServices) }
  });

  return res.json(business);
};

export const addTeamMember = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, name, email, role } = req.body;

  const member = await prisma.teamMember.create({
    data: { businessId, name, email, role: role || 'MEMBER' }
  });

  return res.status(201).json(member);
};