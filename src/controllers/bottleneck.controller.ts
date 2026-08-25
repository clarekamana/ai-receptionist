import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getPendingQuestions = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const questions = await prisma.bottleneckQuestion.findMany({
    where: { businessId: business.id, status: 'PENDING' },
    include: { customer: true },
    orderBy: { createdAt: 'desc' }
  });

  return res.json(questions);
};

export const answerQuestion = async (req: AuthenticatedRequest, res: Response) => {
  const { questionId } = req.params;
  const { answer } = req.body;

  const item = await prisma.bottleneckQuestion.update({
    where: { id: questionId },
    data: { answer, status: 'ANSWERED' }
  });

  // Automatically save answer into Knowledge Base for future AI calls
  await prisma.knowledgeItem.create({
    data: {
      businessId: item.businessId,
      question: item.question,
      answer,
      source: 'CLIENT_CALL'
    }
  });

  return res.json({ message: "Saved — I'll remember this for future calls." });
};

export const skipQuestion = async (req: AuthenticatedRequest, res: Response) => {
  const { questionId } = req.params;

  await prisma.bottleneckQuestion.update({
    where: { id: questionId },
    data: { status: 'SKIPPED' }
  });

  return res.json({ message: 'Question skipped.' });
};