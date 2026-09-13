import { Router } from 'express';
import { getAvailableNumbers, provisionNumber, releaseProvisionedNumber } from '../controllers/phoneProvisioning.controller';
import { authenticate } from '../middlewares/auth.middleware';

// JWT-authenticated, unlike telephony.routes.ts (Twilio webhooks) — this is
// the owner-facing API for real number provisioning, not a Twilio callback.
const router = Router();
router.use(authenticate);

router.get('/available', getAvailableNumbers);
router.post('/provision', provisionNumber);
router.post('/release', releaseProvisionedNumber);

export default router;
