import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getCallHistory = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const calls = await prisma.callLog.findMany({
    where: { businessId: business.id },
    include: { customer: true },
    orderBy: { createdAt: 'desc' }
  });

  return res.json(calls);
};

export const getCallTranscript = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const call = await prisma.callLog.findUnique({
    where: { id },
    include: { customer: true }
  });

  if (!call) return res.status(404).json({ error: 'Call log not found' });
  return res.json(call);
};