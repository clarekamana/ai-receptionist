import { Response } from 'express';
import { prisma } from '../utils/db';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const getCustomers = async (req: AuthenticatedRequest, res: Response) => {
  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const customers = await prisma.customer.findMany({
    where: { businessId: business.id },
    orderBy: { createdAt: 'desc' }
  });

  return res.json(customers);
};

export const getCustomerDetail = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const business = await prisma.business.findFirst({ where: { ownerId: req.userId } });
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const customer = await prisma.customer.findFirst({
    where: { id, businessId: business.id },
    include: {
      appointments: { orderBy: { scheduledAt: 'desc' } },
      callLogs: { orderBy: { createdAt: 'desc' } },
      bottleneckQuestions: { where: { status: 'PENDING' } }
    }
  });

  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  return res.json(customer);
};