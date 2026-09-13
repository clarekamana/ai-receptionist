import { Router } from 'express';
import { signUp, verifyEmailOTP, verifyPhoneOtp, login, resetPasswordRequest, resetPasswordConfirm } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();
router.post('/signup', signUp);
router.post('/verify-otp', authenticate, verifyPhoneOtp);
router.post('/verify-email-otp', verifyEmailOTP);
router.post('/login', login);
router.post('/reset-password', resetPasswordRequest);
router.post('/reset-password/confirm', resetPasswordConfirm);

export default router;