import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getKnowledgeBase = async (req: AuthenticatedRequest, res: Response) => {
  const { search } = req.query;
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const items = await prisma.knowledgeItem.findMany({
    where: {
      businessId: business.id,
      ...(search ? { question: { contains: String(search) } } : {})
    },
    orderBy: { createdAt: 'desc' }
  });

  return res.json(items);
};

export const addKnowledgeItem = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, question, answer, tags } = req.body;

  if (!businessId || !question || !answer) {
    return res.status(400).json({ error: 'businessId, question and answer are required' });
  }

  const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const item = await prisma.knowledgeItem.create({
    data: { businessId, question, answer, tags, source: 'SETUP' }
  });

  return res.status(201).json(item);
};

export const updateKnowledgeItem = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { question, answer, tags } = req.body;

  const existing = await prisma.knowledgeItem.findUnique({ where: { id }, include: { business: true } });
  if (!existing || existing.business.ownerId !== req.userId) {
    return res.status(404).json({ error: 'Knowledge item not found' });
  }

  const item = await prisma.knowledgeItem.update({
    where: { id },
    data: { question, answer, tags }
  });

  return res.json(item);
};

export const deleteKnowledgeItem = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const existing = await prisma.knowledgeItem.findUnique({ where: { id }, include: { business: true } });
  if (!existing || existing.business.ownerId !== req.userId) {
    return res.status(404).json({ error: 'Knowledge item not found' });
  }

  await prisma.knowledgeItem.delete({ where: { id } });
  return res.json({ message: 'Knowledge item removed.' });
};
