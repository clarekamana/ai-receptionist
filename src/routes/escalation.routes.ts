import { Router } from 'express';
import { getEscalationRules, updateEscalationRule, syncEscalationRules } from '../controllers/escalation.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/rules', getEscalationRules);
router.post('/rules', syncEscalationRules);
router.patch('/rules/:id', updateEscalationRule);

export default router;