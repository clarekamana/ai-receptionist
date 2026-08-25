import jwt from 'jsonwebtoken';
import { ENV } from '../config/env';

export const generateToken = (payload: { userId: string }): string => {
  return jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: '30d' });
};

export const verifyToken = (token: string): { userId: string } => {
  return jwt.verify(token, ENV.JWT_SECRET) as { userId: string };
};