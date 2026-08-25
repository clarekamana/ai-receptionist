import { Router } from 'express';
import { getPendingQuestions, answerQuestion, skipQuestion } from '../controllers/bottleneck.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/questions', getPendingQuestions);
router.post('/questions/:questionId/answer', answerQuestion);
router.post('/questions/:questionId/skip', skipQuestion);

export default router;