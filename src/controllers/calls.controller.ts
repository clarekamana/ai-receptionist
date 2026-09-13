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

  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const call = await prisma.callLog.findFirst({
    where: { id, businessId: business.id },
    include: { customer: true }
  });

  if (!call) return res.status(404).json({ error: 'Call log not found' });
  return res.json(call);
};

const VALID_ESCALATION_STATUSES = ['PENDING', 'HANDLED', 'DISMISSED'];

export const getEscalatedCalls = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const calls = await prisma.callLog.findMany({
    where: { businessId: business.id, needsEscalation: true },
    include: { customer: true },
    orderBy: { createdAt: 'desc' }
  });

  return res.json(calls);
};

export const updateEscalationStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { escalationStatus } = req.body;

  if (!VALID_ESCALATION_STATUSES.includes(escalationStatus)) {
    return res.status(400).json({ error: `escalationStatus must be one of ${VALID_ESCALATION_STATUSES.join(', ')}` });
  }

  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const call = await prisma.callLog.findFirst({ where: { id, businessId: business.id, needsEscalation: true } });
  if (!call) return res.status(404).json({ error: 'Escalated call not found' });

  const updated = await prisma.callLog.update({ where: { id }, data: { escalationStatus } });
  return res.json(updated);
};