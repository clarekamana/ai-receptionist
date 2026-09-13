import twilio from 'twilio';
import { ENV } from '../config/env';

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
}

export interface ProvisionedNumber {
  phoneNumber: string;
  sid: string;
}

/**
 * Returns null if Twilio account credentials (not the webhook auth token
 * check in twilioService.ts — the account SID, needed for outbound API
 * calls like search/purchase) aren't configured, so callers can fail
 * closed rather than instantiate a client with an empty SID.
 */
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = ENV;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

export class TwilioNotConfiguredError extends Error {
  constructor() {
    super('Twilio account credentials are not configured.');
    this.name = 'TwilioNotConfiguredError';
  }
}

export async function searchAvailableNumbers(countryCode: string = 'US', limit: number = 10): Promise<AvailableNumber[]> {
  const client = getTwilioClient();
  if (!client) throw new TwilioNotConfiguredError();

  const results = await client.availablePhoneNumbers(countryCode).local.list({ limit, voiceEnabled: true });

  return results.map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality || null,
    region: n.region || null,
  }));
}

export async function purchaseNumber(phoneNumber: string, publicBaseUrl: string): Promise<ProvisionedNumber> {
  const client = getTwilioClient();
  if (!client) throw new TwilioNotConfiguredError();

  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber,
    voiceUrl: `${publicBaseUrl}/api/telephony/voice`,
    voiceMethod: 'POST',
    statusCallback: `${publicBaseUrl}/api/telephony/status`,
    statusCallbackMethod: 'POST',
  });

  return { phoneNumber: purchased.phoneNumber, sid: purchased.sid };
}

export async function releaseNumber(phoneNumberSid: string): Promise<void> {
  const client = getTwilioClient();
  if (!client) throw new TwilioNotConfiguredError();

  await client.incomingPhoneNumbers(phoneNumberSid).remove();
}

// --- Duplicate-provisioning protection -----------------------------------
// A single-process, in-memory guard against a double-tap/double-submit
// triggering two purchases for the same Business before the first one has
// finished writing allocatedPhoneSid to the database. Not a distributed
// lock — running more than one backend instance would need a durable
// equivalent (e.g. a DB-level "provisioning in progress" flag with a
// unique constraint), which this MVP does not implement.
const provisioningInFlight = new Set<string>();

export function beginProvisioning(businessId: string): boolean {
  if (provisioningInFlight.has(businessId)) return false;
  provisioningInFlight.add(businessId);
  return true;
}

export function endProvisioning(businessId: string): void {
  provisioningInFlight.delete(businessId);
}

export function isProvisioning(businessId: string): boolean {
  return provisioningInFlight.has(businessId);
}
