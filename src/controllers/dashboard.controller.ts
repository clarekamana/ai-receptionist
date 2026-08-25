import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getTodayDashboard = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found.' });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [callCount, pendingQuestions, upcomingAppointments] = await Promise.all([
    prisma.callLog.count({
      where: { businessId: business.id, createdAt: { gte: startOfDay } }
    }),
    prisma.bottleneckQuestion.findMany({
      where: { businessId: business.id, status: 'PENDING' },
      include: { customer: true },
      take: 5
    }),
    prisma.appointment.findMany({
      where: { businessId: business.id, scheduledAt: { gte: new Date() } },
      include: { customer: true },
      orderBy: { scheduledAt: 'asc' },
      take: 5
    })
  ]);

  return res.json({
    status: `Your AI is handling things — ${pendingQuestions.length} question(s) need you.`,
    todayCallsCount: callCount,
    pendingQuestionsCount: pendingQuestions.length,
    pendingQuestions,
    upcomingAppointments
  });
};