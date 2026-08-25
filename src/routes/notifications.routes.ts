import { Router } from 'express';
import { getNotificationSettings, updateNotificationSettings } from '../controllers/notifications.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/', getNotificationSettings);
router.put('/', updateNotificationSettings);

export default router;