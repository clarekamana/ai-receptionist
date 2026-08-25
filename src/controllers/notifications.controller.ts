import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getNotificationSettings = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const settings = await prisma.notificationSetting.findUnique({
    where: { businessId: business.id }
  });

  return res.json(settings);
};

export const updateNotificationSettings = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const { urgentPush, digestEmail, digestFrequency } = req.body;

  const updated = await prisma.notificationSetting.upsert({
    where: { businessId: business.id },
    update: { urgentPush, digestEmail, digestFrequency },
    create: { businessId: business.id, urgentPush, digestEmail, digestFrequency }
  });

  return res.json(updated);
};