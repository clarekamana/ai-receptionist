import { Router } from 'express';
import {
  createAppCallHandler,
  getAppCallHandler,
  connectAppCallHandler,
  endAppCallHandler,
  failAppCallHandler,
} from './call.controller';
import { authenticateCallToken } from './call.auth';

const router = Router();

// Public — creating a call is how a customer starts talking to a
// business's AI receptionist at all, and there's no customer account
// system to require here (mirrors dialing a published phone number today).
router.post('/', createAppCallHandler);

// Everything past creation requires the call-scoped token minted above,
// and that token's callId must match :callId (enforced in call.auth.ts).
router.get('/:callId', authenticateCallToken, getAppCallHandler);
router.post('/:callId/connect', authenticateCallToken, connectAppCallHandler);
router.post('/:callId/end', authenticateCallToken, endAppCallHandler);
router.post('/:callId/fail', authenticateCallToken, failAppCallHandler);

export default router;
