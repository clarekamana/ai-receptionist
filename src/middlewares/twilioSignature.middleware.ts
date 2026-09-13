import { Request, Response, NextFunction } from 'express';
import { getTwilioConfig, isValidTwilioSignature } from '../services/twilioService';

/**
 * Verifies the X-Twilio-Signature header before any application logic runs.
 * This route group is intentionally NOT behind the JWT `authenticate`
 * middleware — a telephony provider has no user session — so this is the
 * only thing standing between the public internet and these endpoints.
 *
 * Fails closed in every case: missing config, missing header, or a bad
 * signature all reject the request. A rejected request here means either
 * "this server isn't configured for telephony yet" or "this almost
 * certainly isn't really Twilio" — neither case has a real caller on the
 * line waiting for a spoken response, so this responds plainly (no TwiML)
 * rather than trying to render voice output.
 */
export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction) {
  const config = getTwilioConfig();

  if (!config) {
    // Never log the token itself — only that it's absent.
    console.error(
      '[telephony] Rejected webhook: TWILIO_AUTH_TOKEN and/or PUBLIC_BASE_URL are not set. ' +
        'Set both in .env (see .env.example) before pointing Twilio at this server.'
    );
    return res.status(500).send('Telephony is not configured.');
  }

  const signature = req.header('X-Twilio-Signature');

  const valid = isValidTwilioSignature(config, signature, req.originalUrl, req.body);

  if (!valid) {
    // Deliberately not logging the signature header or the body — both can
    // carry caller-supplied data and, in the signature's case, is the exact
    // secret-derived value an attacker would want confirmed/denied.
    console.warn(`[telephony] Rejected webhook with ${signature ? 'invalid' : 'missing'} X-Twilio-Signature.`);
    return res.status(403).send('Invalid signature.');
  }

  next();
}
