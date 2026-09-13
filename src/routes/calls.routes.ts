import { Router } from 'express';
import { getCallHistory, getCallTranscript, getEscalatedCalls, updateEscalationStatus } from '../controllers/calls.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/escalations', getEscalatedCalls);
router.get('/', getCallHistory);
router.get('/:id/transcript', getCallTranscript);
router.patch('/:id/escalation', updateEscalationStatus);

export default router;