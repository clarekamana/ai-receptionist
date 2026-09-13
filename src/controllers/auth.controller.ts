import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/db';
import { generateToken } from '../utils/jwt';
import { sendOTPNotice, sendPasswordResetNotice } from '../services/emailService';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PASSWORD_MIN_LENGTH = 8;

const generateOTP = (): string => Math.floor(100000 + Math.random() * 900000).toString();

const publicUser = (user: { id: string; email: string; emailVerified: boolean }) => ({
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerified,
});

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const otpCode = generateOTP();
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        otpCode,
        otpExpiresAt,
        otpPurpose: 'EMAIL_VERIFICATION',
        emailVerified: false,
      },
    });

    const emailSent = await sendOTPNotice(normalizedEmail, otpCode);

    if (!emailSent) {
      // Don't leave an unverifiable account behind if we couldn't deliver the OTP.
      await prisma.user.delete({ where: { id: user.id } });
      return res.status(500).json({ message: 'Failed to send verification email.' });
    }

    const token = generateToken({ userId: user.id });

    return res.status(201).json({
      message: 'Registration initiated. Verification OTP sent to email.',
      token,
      user: publicUser(user),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Server error' });
  }
};

// Alias preserved for existing consumers.
export const signUp = register;

export const verifyEmailOTP = async (req: Request, res: Response) => {
  try {
    const { email, otpCode } = req.body;

    if (!email || !otpCode) {
      return res.status(400).json({ message: 'Email and OTP code are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user || !user.otpCode || !user.otpExpiresAt || user.otpPurpose !== 'EMAIL_VERIFICATION') {
      return res.status(400).json({ message: 'No OTP requested for this email' });
    }

    if (Date.now() > user.otpExpiresAt.getTime()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { otpCode: null, otpExpiresAt: null, otpPurpose: null },
      });
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    if (user.otpCode !== String(otpCode)) {
      return res.status(400).json({ message: 'Invalid OTP code' });
    }

    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: { otpCode: null, otpExpiresAt: null, otpPurpose: null, emailVerified: true },
    });

    const token = generateToken({ userId: verifiedUser.id });

    return res.status(200).json({
      message: 'Email verified successfully',
      token,
      user: publicUser(verifiedUser),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Server error' });
  }
};

// Alias preserved for existing consumers.
export const verifyPhoneOtp = verifyEmailOTP;

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = generateToken({ userId: user.id });

    return res.status(200).json({
      message: 'Login successful',
      token,
      user: publicUser(user),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Server error' });
  }
};

// Same wording regardless of whether the account exists, so this endpoint
// can't be used to enumerate registered emails.
const RESET_REQUEST_ACK = { message: 'If an account exists for that email, a password reset code has been sent.' };

export const resetPasswordRequest = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    // Deliberately return the same response whether or not the account
    // exists — only the side effect (an email being sent) differs.
    if (!user) {
      return res.status(200).json(RESET_REQUEST_ACK);
    }

    const otpCode = generateOTP();
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

    await prisma.user.update({
      where: { id: user.id },
      data: { otpCode, otpExpiresAt, otpPurpose: 'PASSWORD_RESET' },
    });

    await sendPasswordResetNotice(normalizedEmail, otpCode);

    return res.status(200).json(RESET_REQUEST_ACK);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Server error' });
  }
};

export const resetPasswordConfirm = async (req: Request, res: Response) => {
  try {
    const { email, otpCode, newPassword } = req.body;

    if (!email || !otpCode || !newPassword) {
      return res.status(400).json({ message: 'Email, OTP code, and new password are required' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user || !user.otpCode || !user.otpExpiresAt || user.otpPurpose !== 'PASSWORD_RESET') {
      return res.status(400).json({ message: 'No password reset was requested for this email' });
    }

    if (Date.now() > user.otpExpiresAt.getTime()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { otpCode: null, otpExpiresAt: null, otpPurpose: null },
      });
      return res.status(400).json({ message: 'This code has expired. Please request a new one.' });
    }

    if (user.otpCode !== String(otpCode)) {
      return res.status(400).json({ message: 'Invalid code' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Clearing otpCode/otpExpiresAt/otpPurpose here means this exact code
    // can never be replayed, whether by an attacker or a duplicate request.
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, otpCode: null, otpExpiresAt: null, otpPurpose: null },
    });

    return res.status(200).json({ message: 'Password updated. Please log in with your new password.' });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Server error' });
  }
};
