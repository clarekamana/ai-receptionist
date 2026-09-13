import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';

jest.mock('../services/emailService', () => ({
  sendOTPNotice: jest.fn(),
  sendPasswordResetNotice: jest.fn(),
}));

import { sendOTPNotice, sendPasswordResetNotice } from '../services/emailService';
import { register, verifyEmailOTP, login, resetPasswordRequest, resetPasswordConfirm } from '../controllers/auth.controller';
import { verifyToken } from '../utils/jwt';
import { prisma } from '../utils/db';

const mockedSendOTPNotice = sendOTPNotice as jest.Mock;
const mockedSendPasswordResetNotice = sendPasswordResetNotice as jest.Mock;

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

function mockReq(body: Record<string, any>) {
  return { body } as Request;
}

async function getUser(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

describe('auth.controller', () => {
  beforeEach(() => {
    mockedSendOTPNotice.mockReset();
    mockedSendOTPNotice.mockResolvedValue(true);
    mockedSendPasswordResetNotice.mockReset();
    mockedSendPasswordResetNotice.mockResolvedValue(true);
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: '@auth-test.dev' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('register', () => {
    it('creates a User row in the database', async () => {
      const req = mockReq({ email: 'create@auth-test.dev', password: 'password123' });
      const res = mockRes();

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const user = await getUser('create@auth-test.dev');
      expect(user).not.toBeNull();
      expect(user?.emailVerified).toBe(false);
    });

    it('stores a hashed password, not the plaintext', async () => {
      const req = mockReq({ email: 'hash@auth-test.dev', password: 'password123' });
      const res = mockRes();

      await register(req, res);

      const user = await getUser('hash@auth-test.dev');
      expect(user?.passwordHash).not.toBe('password123');
      await expect(bcrypt.compare('password123', user!.passwordHash)).resolves.toBe(true);
    });

    it('stores a 6-digit OTP with a ~10 minute expiry', async () => {
      const req = mockReq({ email: 'otp@auth-test.dev', password: 'password123' });
      const res = mockRes();

      const before = Date.now();
      await register(req, res);

      const user = await getUser('otp@auth-test.dev');
      expect(user?.otpCode).toMatch(/^\d{6}$/);
      expect(user?.otpExpiresAt).not.toBeNull();

      const expiresInMs = user!.otpExpiresAt!.getTime() - before;
      expect(expiresInMs).toBeGreaterThan(9 * 60 * 1000);
      expect(expiresInMs).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    });

    it('returns a JWT containing the real database user id', async () => {
      const req = mockReq({ email: 'jwt@auth-test.dev', password: 'password123' });
      const res = mockRes();

      await register(req, res);

      const user = await getUser('jwt@auth-test.dev');
      const responseBody = res.json.mock.calls[0][0];
      const decoded = verifyToken(responseBody.token);

      expect(decoded.userId).toBe(user!.id);
      expect(decoded.userId).not.toBe('f18355ea-ae34-49eb-9cf0-8fade76d5808');
    });

    it('rejects a duplicate email', async () => {
      const req1 = mockReq({ email: 'dup@auth-test.dev', password: 'password123' });
      await register(req1, mockRes());

      const req2 = mockReq({ email: 'dup@auth-test.dev', password: 'password456' });
      const res2 = mockRes();
      await register(req2, res2);

      expect(res2.status).toHaveBeenCalledWith(409);
      const users = await prisma.user.findMany({ where: { email: 'dup@auth-test.dev' } });
      expect(users).toHaveLength(1);
    });

    it('rejects invalid email format', async () => {
      const req = mockReq({ email: 'not-an-email', password: 'password123' });
      const res = mockRes();

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(await getUser('not-an-email')).toBeNull();
    });

    it('rejects a too-short password', async () => {
      const req = mockReq({ email: 'shortpw@auth-test.dev', password: 'abc' });
      const res = mockRes();

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(await getUser('shortpw@auth-test.dev')).toBeNull();
    });

    it('rolls back user creation when the OTP email fails to send', async () => {
      mockedSendOTPNotice.mockResolvedValueOnce(false);
      const req = mockReq({ email: 'emailfail@auth-test.dev', password: 'password123' });
      const res = mockRes();

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(await getUser('emailfail@auth-test.dev')).toBeNull();
    });
  });

  describe('verifyEmailOTP', () => {
    async function registerUser(email: string) {
      await register(mockReq({ email, password: 'password123' }), mockRes());
      return getUser(email);
    }

    it('verifies the user with a valid OTP and clears OTP fields', async () => {
      const email = 'valid-otp@auth-test.dev';
      const user = await registerUser(email);

      const res = mockRes();
      await verifyEmailOTP(mockReq({ email, otpCode: user!.otpCode }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      const verified = await getUser(email);
      expect(verified?.emailVerified).toBe(true);
      expect(verified?.otpCode).toBeNull();
      expect(verified?.otpExpiresAt).toBeNull();
    });

    it('returns a JWT for the real user id on successful verification', async () => {
      const email = 'verify-jwt@auth-test.dev';
      const user = await registerUser(email);

      const res = mockRes();
      await verifyEmailOTP(mockReq({ email, otpCode: user!.otpCode }), res);

      const responseBody = res.json.mock.calls[0][0];
      const decoded = verifyToken(responseBody.token);
      expect(decoded.userId).toBe(user!.id);
    });

    it('rejects an invalid OTP', async () => {
      const email = 'invalid-otp@auth-test.dev';
      await registerUser(email);

      const res = mockRes();
      await verifyEmailOTP(mockReq({ email, otpCode: '000000' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      const user = await getUser(email);
      expect(user?.emailVerified).toBe(false);
      expect(user?.otpCode).not.toBeNull();
    });

    it('rejects an expired OTP and clears it', async () => {
      const email = 'expired-otp@auth-test.dev';
      const user = await registerUser(email);

      await prisma.user.update({
        where: { id: user!.id },
        data: { otpExpiresAt: new Date(Date.now() - 1000) },
      });

      const res = mockRes();
      await verifyEmailOTP(mockReq({ email, otpCode: user!.otpCode }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      const refreshed = await getUser(email);
      expect(refreshed?.emailVerified).toBe(false);
      expect(refreshed?.otpCode).toBeNull();
    });

    it('rejects a missing OTP code', async () => {
      const email = 'missing-otp@auth-test.dev';
      await registerUser(email);

      const res = mockRes();
      await verifyEmailOTP(mockReq({ email }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('password reset', () => {
    async function registerAndVerify(email: string, password = 'password123') {
      await register(mockReq({ email, password }), mockRes());
      const user = await getUser(email);
      await verifyEmailOTP(mockReq({ email, otpCode: user!.otpCode }), mockRes());
      return getUser(email);
    }

    it('sends a reset code for an existing account and stores it with an expiry', async () => {
      const email = 'reset-request@auth-test.dev';
      await registerAndVerify(email);

      const before = Date.now();
      const res = mockRes();
      await resetPasswordRequest(mockReq({ email }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockedSendPasswordResetNotice).toHaveBeenCalledTimes(1);

      const user = await getUser(email);
      expect(user?.otpCode).toMatch(/^\d{6}$/);
      expect(user?.otpPurpose).toBe('PASSWORD_RESET');
      expect(user!.otpExpiresAt!.getTime()).toBeGreaterThan(before);
    });

    it('does not leak account existence: identical response for an unknown email', async () => {
      const knownEmail = 'reset-enum-known@auth-test.dev';
      await registerAndVerify(knownEmail);

      const knownRes = mockRes();
      await resetPasswordRequest(mockReq({ email: knownEmail }), knownRes);

      const unknownRes = mockRes();
      await resetPasswordRequest(mockReq({ email: 'reset-enum-unknown@auth-test.dev' }), unknownRes);

      expect(knownRes.status).toHaveBeenCalledWith(200);
      expect(unknownRes.status).toHaveBeenCalledWith(200);
      expect(knownRes.json.mock.calls[0][0]).toEqual(unknownRes.json.mock.calls[0][0]);
      // No email is sent for an account that doesn't exist.
      expect(mockedSendPasswordResetNotice).toHaveBeenCalledTimes(1);
    });

    it('completes the reset with a valid OTP, hashing the new password', async () => {
      const email = 'reset-success@auth-test.dev';
      await registerAndVerify(email, 'oldPassword123');
      await resetPasswordRequest(mockReq({ email }), mockRes());

      const pending = await getUser(email);
      const res = mockRes();
      await resetPasswordConfirm(mockReq({ email, otpCode: pending!.otpCode, newPassword: 'newPassword456' }), res);

      expect(res.status).toHaveBeenCalledWith(200);

      const updated = await getUser(email);
      expect(updated?.passwordHash).not.toBe(pending?.passwordHash);
      await expect(bcrypt.compare('newPassword456', updated!.passwordHash)).resolves.toBe(true);
      await expect(bcrypt.compare('oldPassword123', updated!.passwordHash)).resolves.toBe(false);
    });

    it('invalidates the OTP after a successful reset (cannot be reused)', async () => {
      const email = 'reset-no-reuse@auth-test.dev';
      await registerAndVerify(email);
      await resetPasswordRequest(mockReq({ email }), mockRes());

      const pending = await getUser(email);
      await resetPasswordConfirm(mockReq({ email, otpCode: pending!.otpCode, newPassword: 'firstNewPass1' }), mockRes());

      const afterFirstUse = await getUser(email);
      expect(afterFirstUse?.otpCode).toBeNull();
      expect(afterFirstUse?.otpPurpose).toBeNull();

      const secondAttempt = mockRes();
      await resetPasswordConfirm(
        mockReq({ email, otpCode: pending!.otpCode, newPassword: 'secondNewPass2' }),
        secondAttempt
      );

      expect(secondAttempt.status).toHaveBeenCalledWith(400);
      const stillFirstPassword = await getUser(email);
      await expect(bcrypt.compare('firstNewPass1', stillFirstPassword!.passwordHash)).resolves.toBe(true);
    });

    it('rejects an incorrect OTP without changing the password', async () => {
      const email = 'reset-wrong-otp@auth-test.dev';
      const original = await registerAndVerify(email, 'originalPass1');
      await resetPasswordRequest(mockReq({ email }), mockRes());

      const res = mockRes();
      await resetPasswordConfirm(mockReq({ email, otpCode: '000000', newPassword: 'attackerPass1' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      const unchanged = await getUser(email);
      expect(unchanged?.passwordHash).toBe(original?.passwordHash);
    });

    it('rejects an expired reset OTP and clears it', async () => {
      const email = 'reset-expired@auth-test.dev';
      await registerAndVerify(email);
      await resetPasswordRequest(mockReq({ email }), mockRes());

      const pending = await getUser(email);
      await prisma.user.update({ where: { id: pending!.id }, data: { otpExpiresAt: new Date(Date.now() - 1000) } });

      const res = mockRes();
      await resetPasswordConfirm(
        mockReq({ email, otpCode: pending!.otpCode, newPassword: 'wontBeUsed1' }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(400);
      const refreshed = await getUser(email);
      expect(refreshed?.otpCode).toBeNull();
    });

    it('rejects a too-short new password without consuming the OTP', async () => {
      const email = 'reset-short-pw@auth-test.dev';
      await registerAndVerify(email);
      await resetPasswordRequest(mockReq({ email }), mockRes());

      const pending = await getUser(email);
      const res = mockRes();
      await resetPasswordConfirm(mockReq({ email, otpCode: pending!.otpCode, newPassword: 'short' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      const stillPending = await getUser(email);
      expect(stillPending?.otpCode).toBe(pending?.otpCode);
    });

    it('cannot be used to reset a different account (OTP is scoped to the requesting email)', async () => {
      const victimEmail = 'reset-victim@auth-test.dev';
      const attackerEmail = 'reset-attacker@auth-test.dev';
      await registerAndVerify(victimEmail, 'victimPassword1');
      await registerAndVerify(attackerEmail, 'attackerPassword1');

      await resetPasswordRequest(mockReq({ email: attackerEmail }), mockRes());
      const attackerPending = await getUser(attackerEmail);

      // Attacker tries their own valid OTP against the victim's email.
      const res = mockRes();
      await resetPasswordConfirm(
        mockReq({ email: victimEmail, otpCode: attackerPending!.otpCode, newPassword: 'hijackedPass1' }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(400);
      const victim = await getUser(victimEmail);
      await expect(bcrypt.compare('victimPassword1', victim!.passwordHash)).resolves.toBe(true);
    });

    it('a reset OTP cannot be used to verify email (purposes are isolated)', async () => {
      const email = 'reset-purpose-isolation@auth-test.dev';
      await register(mockReq({ email, password: 'password123' }), mockRes());
      // Not yet verified. Now request a password reset, which overwrites
      // the pending email-verification OTP with a PASSWORD_RESET one.
      await resetPasswordRequest(mockReq({ email }), mockRes());

      const pending = await getUser(email);
      const res = mockRes();
      await verifyEmailOTP(mockReq({ email, otpCode: pending!.otpCode }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      const user = await getUser(email);
      expect(user?.emailVerified).toBe(false);
    });

    it('allows login with the new password and rejects the old one', async () => {
      const email = 'reset-login@auth-test.dev';
      await registerAndVerify(email, 'originalPassword1');
      await resetPasswordRequest(mockReq({ email }), mockRes());

      const pending = await getUser(email);
      await resetPasswordConfirm(
        mockReq({ email, otpCode: pending!.otpCode, newPassword: 'brandNewPassword1' }),
        mockRes()
      );

      const oldLoginRes = mockRes();
      await login(mockReq({ email, password: 'originalPassword1' }), oldLoginRes);
      expect(oldLoginRes.status).toHaveBeenCalledWith(401);

      const newLoginRes = mockRes();
      await login(mockReq({ email, password: 'brandNewPassword1' }), newLoginRes);
      expect(newLoginRes.status).toHaveBeenCalledWith(200);
    });

    it('never includes the OTP or password hash in any response body', async () => {
      const email = 'reset-no-leak@auth-test.dev';
      await registerAndVerify(email);

      const requestRes = mockRes();
      await resetPasswordRequest(mockReq({ email }), requestRes);
      expect(JSON.stringify(requestRes.json.mock.calls[0][0])).not.toMatch(/\d{6}/);

      const pending = await getUser(email);
      const confirmRes = mockRes();
      await resetPasswordConfirm(
        mockReq({ email, otpCode: pending!.otpCode, newPassword: 'finalPassword1' }),
        confirmRes
      );
      const confirmBody = JSON.stringify(confirmRes.json.mock.calls[0][0]);
      expect(confirmBody).not.toContain(pending!.otpCode);
      expect(confirmBody.toLowerCase()).not.toContain('hash');
    });
  });
});
