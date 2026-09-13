import twilio from 'twilio';
import { ENV } from '../config/env';

export interface TwilioConfig {
  authToken: string;
  publicBaseUrl: string;
}

/**
 * Returns the telephony config, or null if anything required is missing.
 * Never falls back to a fake value — an absent config must fail closed.
 */
export function getTwilioConfig(): TwilioConfig | null {
  const { TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL } = ENV;
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) return null;
  return { authToken: TWILIO_AUTH_TOKEN, publicBaseUrl: PUBLIC_BASE_URL };
}

/**
 * Validates the X-Twilio-Signature header against the exact public URL this
 * request was delivered to plus its form-encoded params, per Twilio's
 * documented signing scheme. `originalUrl` should be the request's path
 * (+ query string, if any) exactly as configured in the Twilio console.
 */
export function isValidTwilioSignature(
  config: TwilioConfig,
  signature: string | undefined,
  originalUrl: string,
  params: Record<string, any>
): boolean {
  if (!signature) return false;

  const url = `${config.publicBaseUrl}${originalUrl}`;
  return twilio.validateRequest(config.authToken, signature, url, params || {});
}

/**
 * Minimal formatting-only normalization for matching a webhook's `To`
 * number against Business.allocatedPhone: strips everything but digits and
 * a leading "+". Does not attempt country-code inference or real E.164
 * validation — Twilio already delivers `To` in E.164, this just guards
 * against incidental formatting differences (spaces/dashes/parens).
 */
export function normalizePhoneForLookup(value: string): string {
  const trimmed = value.trim();
  const hasLeadingPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  return hasLeadingPlus ? `+${digits}` : digits;
}
