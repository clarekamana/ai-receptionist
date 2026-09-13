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

  const existing = await prisma.escalationRule.findUnique({ where: { id }, include: { business: true } });
  if (!existing || existing.business.ownerId !== req.userId) {
    return res.status(404).json({ error: 'Escalation rule not found' });
  }

  const rule = await prisma.escalationRule.update({
    where: { id },
    data: { askOwner }
  });

  return res.json(rule);
};

/**
 * Bulk create/update the EscalationRule rows for a Business from a set of
 * named topics (e.g. onboarding's pricing/complaints/cancellations/vip
 * selections). This is the canonical write path for escalation config that
 * aiCallService.buildSystemPrompt reads — it must always end up here, not
 * just in OnboardingState.stepData.
 *
 * Safe to call repeatedly: each topic is upserted by (businessId, topic), so
 * resubmitting the same selections updates the existing rows instead of
 * creating duplicates. A topic the user turns off is disabled (askOwner:
 * false) rather than deleted, since askOwner is exactly the schema's existing
 * mechanism for "don't escalate this" and buildSystemPrompt filters on it.
 */
export const syncEscalationRules = async (req: AuthenticatedRequest, res: Response) => {
  const { businessId, rules } = req.body;

  if (!businessId || !Array.isArray(rules)) {
    return res.status(400).json({ error: 'businessId and rules[] are required' });
  }

  const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const validRules = rules.filter((rule: any) => rule && typeof rule.topic === 'string' && rule.topic.trim());

  const results = await Promise.all(
    validRules.map((rule: { topic: string; description?: string; enabled: boolean }) =>
      prisma.escalationRule.upsert({
        where: { businessId_topic: { businessId, topic: rule.topic } },
        update: { askOwner: !!rule.enabled, description: rule.description },
        create: { businessId, topic: rule.topic, askOwner: !!rule.enabled, description: rule.description },
      })
    )
  );

  return res.json(results);
};
