import { Router } from 'express';
import { getEscalationRules, updateEscalationRule } from '../controllers/escalation.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/rules', getEscalationRules);
router.patch('/rules/:id', updateEscalationRule);

export default router;