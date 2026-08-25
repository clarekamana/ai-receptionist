import { Router } from 'express';
import { getTodayDashboard } from '../controllers/dashboard.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.get('/today', authenticate, getTodayDashboard);

export default router;