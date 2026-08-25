import { Router } from 'express';
import { createBusinessProfile, updateOnboardingStep, setupPhoneNumber } from '../controllers/onboarding.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(authenticate);
router.post('/business', createBusinessProfile);
router.post('/step', updateOnboardingStep);
router.post('/phone-setup', setupPhoneNumber);

export default router;