import { Router } from 'express';
import { getCallHistory, getCallTranscript } from '../controllers/calls.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/', getCallHistory);
router.get('/:id/transcript', getCallTranscript);

export default router;