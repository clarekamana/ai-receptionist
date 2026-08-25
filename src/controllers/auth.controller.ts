import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/db';
import { generateToken } from '../utils/jwt';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const signUp = async (req: Request, res: Response) => {
  const { email, password, phone, name } = req.body;
  if (!email || !password || !phone) {
    return res.status(400).json({ error: 'Email, password, and phone are required.' });
  }

  const existingUser = await prisma.user.findFirst({
    where: { OR: [{ email }, { phone }] }
  });

  if (existingUser) {
    return res.status(400).json({ error: 'User with this email or phone already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const otpCode = '123456'; // Mocked OTP for development

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      phone,
      name,
      otpCode
    }
  });

  const token = generateToken({ userId: user.id });
  return res.status(201).json({
    message: 'User registered. Please verify phone number.',
    token,
    otpCode, // Returned for dev testing convenience
    user: { id: user.id, email: user.email, phone: user.phone, phoneVerified: user.phoneVerified }
  });
};

export const verifyPhoneOtp = async (req: AuthenticatedRequest, res: Response) => {
  const { otp } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.userId } });

  if (!user || user.otpCode !== otp) {
    return res.status(400).json({ error: 'Invalid verification code.' });
  }

  await prisma.user.update({
    where: { id: req.userId },
    data: { phoneVerified: true, otpCode: null }
  });

  return res.json({ message: 'Phone number verified successfully.' });
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = generateToken({ userId: user.id });
  return res.json({
    token,
    user: { id: user.id, email: user.email, phone: user.phone, phoneVerified: user.phoneVerified }
  });
};

export const resetPasswordRequest = async (req: Request, res: Response) => {
  const { email } = req.body;
  return res.json({ message: `Password reset link sent to ${email} (mocked).` });
};