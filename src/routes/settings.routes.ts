import { Router } from 'express';
import { getAccountAndBusiness, updateBusinessProfile, addTeamMember } from '../controllers/settings.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.get('/', getAccountAndBusiness);
router.put('/business', updateBusinessProfile);
router.post('/team', addTeamMember);

export default router;