import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getEscalationRules = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const rules = await prisma.escalationRule.findMany({
    where: { businessId: business.id }
  });

  return res.json(rules);
};

export const updateEscalationRule = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { askOwner } = req.body;

  const rule = await prisma.escalationRule.update({
    where: { id },
    data: { askOwner }
  });

  return res.json(rule);
};