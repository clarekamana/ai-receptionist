import 'dotenv/config';
import nodemailer from 'nodemailer';

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS?.replace(/\s+/g, ''); // Remove spaces from app password

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true for 465, false for 587
  auth: {
    user,
    pass,
  },
});

export const sendOTPNotice = async (toEmail: string, otpCode: string): Promise<boolean> => {
  try {
    if (!user || !pass) {
      throw new Error('SMTP credentials missing. Check your .env file.');
    }

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || `"AI Receptionist" <${user}>`,
      to: toEmail,
      subject: 'Verify Your Email - AI Receptionist',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2>Email Verification</h2>
          <p>Your verification code for completing registration is:</p>
          <h1 style="color: #00665E; letter-spacing: 4px; font-size: 32px;">${otpCode}</h1>
          <p>This code will expire in 10 minutes.</p>
          <p>If you did not request this code, please ignore this email.</p>
        </div>
      `,
    });

    console.log(`Email OTP sent successfully to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('Failed to send email OTP:', error);
    return false;
  }
};

/**
 * Same OTP delivery mechanism as sendOTPNotice (registration verification),
 * but with copy that doesn't falsely tell the recipient this is about
 * "completing registration" — reuses the transporter/config, not a second
 * email system.
 */
export const sendPasswordResetNotice = async (toEmail: string, otpCode: string): Promise<boolean> => {
  try {
    if (!user || !pass) {
      throw new Error('SMTP credentials missing. Check your .env file.');
    }

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || `"AI Receptionist" <${user}>`,
      to: toEmail,
      subject: 'Reset Your Password - AI Receptionist',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2>Password Reset</h2>
          <p>Your password reset code is:</p>
          <h1 style="color: #00665E; letter-spacing: 4px; font-size: 32px;">${otpCode}</h1>
          <p>This code will expire in 10 minutes.</p>
          <p>If you did not request a password reset, please ignore this email — your password will not be changed.</p>
        </div>
      `,
    });

    console.log(`Password reset code sent successfully to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('Failed to send password reset code:', error);
    return false;
  }
};

export interface EscalationNoticeInput {
  businessName: string;
  callerPhone: string;
  reason: string;
  occurredAt: Date;
}

/**
 * Notifies the business owner that a call needs human follow-up. Only ever
 * given the already-sanitized fields above — never the raw transcript,
 * system prompt, or any API keys/config.
 */
export const sendEscalationNotice = async (
  toEmail: string,
  input: EscalationNoticeInput
): Promise<boolean> => {
  try {
    if (!user || !pass) {
      throw new Error('SMTP credentials missing. Check your .env file.');
    }

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || `"AI Receptionist" <${user}>`,
      to: toEmail,
      subject: `Action needed: a caller for ${input.businessName} needs follow-up`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2>A caller needs your attention</h2>
          <p><strong>Business:</strong> ${input.businessName}</p>
          <p><strong>Caller:</strong> ${input.callerPhone}</p>
          <p><strong>When:</strong> ${input.occurredAt.toLocaleString()}</p>
          <p><strong>Reason:</strong> ${input.reason}</p>
          <p>Open the app to see the full call details and follow up.</p>
        </div>
      `,
    });

    console.log(`Escalation notice sent successfully to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('Failed to send escalation notice:', error);
    return false;
  }
};