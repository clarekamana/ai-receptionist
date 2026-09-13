import jwt from 'jsonwebtoken';
import { Response, NextFunction } from 'express';
import { Request } from 'express';
import { ENV } from '../config/env';
import { CallTokenClaims } from './call.types';

// Deliberately short-lived — this token only needs to outlive a single
// call attempt, unlike the 30-day account session token in utils/jwt.ts.
const CALL_TOKEN_TTL = '2h';

export function issueCallToken(claims: CallTokenClaims): string {
  return jwt.sign(claims, ENV.JWT_SECRET, { expiresIn: CALL_TOKEN_TTL });
}

export function verifyCallToken(token: string): CallTokenClaims {
  const decoded = jwt.verify(token, ENV.JWT_SECRET) as CallTokenClaims;
  if (decoded.scope !== 'app_call' || !decoded.callId || !decoded.businessId) {
    throw new Error('Not a valid call token.');
  }
  return decoded;
}

export interface CallAuthedRequest extends Request {
  callClaims?: CallTokenClaims;
}

/**
 * Gates every call-lifecycle action (issuing a transport token, ending the
 * call, polling state) behind possession of the token minted when the call
 * was created. This is what stops a customer from acting on `callId`s that
 * aren't theirs — the token's `callId` must match the route param, and the
 * caller can't forge one without ENV.JWT_SECRET.
 */
export function authenticateCallToken(req: CallAuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing call token' });
  }

  try {
    const claims = verifyCallToken(authHeader.split(' ')[1]);

    if (req.params.callId && req.params.callId !== claims.callId) {
      return res.status(403).json({ error: 'This call token does not grant access to this call.' });
    }

    req.callClaims = claims;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired call token' });
  }
}
