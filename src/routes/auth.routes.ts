import { Router } from 'express';
import { signUp, verifyPhoneOtp, login, resetPasswordRequest } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.post('/signup', signUp);
router.post('/verify-otp', authenticate, verifyPhoneOtp);
router.post('/login', login);
router.post('/reset-password', resetPasswordRequest);

export default router;