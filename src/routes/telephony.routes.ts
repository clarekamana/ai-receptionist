import { Router } from 'express';
import { handleIncomingVoice, handleCallStatus } from '../controllers/telephony.controller';
import { verifyTwilioSignature } from '../middlewares/twilioSignature.middleware';

// Deliberately NOT using the JWT `authenticate` middleware anywhere in this
// router — Twilio has no user session. verifyTwilioSignature is the only
// gate, and it runs before any application logic in the controllers.
const router = Router();

router.post('/voice', verifyTwilioSignature, handleIncomingVoice);
router.post('/status', verifyTwilioSignature, handleCallStatus);

export default router;
 