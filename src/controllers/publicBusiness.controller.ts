import { Request, Response } from 'express';
import { prisma } from '../utils/db';

/**
 * Public, read-only Mwakire business-discovery endpoints for the customer
 * app. Deliberately NOT behind `authenticate` — browsing/searching
 * businesses must not require an account (see the owner-facing controllers
 * for the authenticated equivalents).
 *
 * Every response here is built through toPublicBusiness() below, which is
 * the single allowlist boundary for what a customer is allowed to see.
 * Nothing here introduces telephony/carrier concepts — `callNumber` is
 * just "the phone number to dial," independent of whatever sits behind it
 * (Twilio today, something else later).
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

interface ParsedHours {
  selectedDays?: string[];
  openingTime?: string;
  closingTime?: string;
}

function parseHours(raw: string | null): ParsedHours | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.selectedDays) && typeof parsed.openingTime === 'string' && typeof parsed.closingTime === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseTimeDisplay(display: string): { hour: number; minute: number; period: 'AM' | 'PM' } | null {
  const match = display.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10), period: match[3].toUpperCase() as 'AM' | 'PM' };
}

function timeToMinutes(display: string): number | null {
  const parsed = parseTimeDisplay(display);
  if (!parsed) return null;
  const hour24 = (parsed.hour % 12) + (parsed.period === 'PM' ? 12 : 0);
  return hour24 * 60 + parsed.minute;
}

/**
 * Computes "open now" in the business's own timezone. Returns null (omit
 * the badge) rather than guessing when hours/timezone data isn't usable —
 * never fabricate an open/closed state.
 */
function computeIsOpenNow(hours: ParsedHours | null, timezone: string, now: Date = new Date()): boolean | null {
  // Note: an empty selectedDays array is meaningfully different from no
  // hours configured at all — it means "closed every day," a real `false`,
  // not an "unknown" `null`. Only bail out to null when the data itself is
  // unusable.
  if (!hours || !Array.isArray(hours.selectedDays) || !hours.openingTime || !hours.closingTime) return null;

  if (hours.selectedDays.length === 0) return false;

  let dayName: string;
  let hour: number;
  let minute: number;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    dayName = parts.find((p) => p.type === 'weekday')?.value || '';
    hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '', 10);
    minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '', 10);
  } catch {
    // Invalid/unsupported timezone string — don't guess.
    return null;
  }

  if (Number.isNaN(hour) || Number.isNaN(minute) || !DAY_ABBREVIATIONS.includes(dayName)) {
    // Couldn't read the current time in this timezone reliably.
    return null;
  }

  if (!hours.selectedDays.includes(dayName)) {
    // Definitively closed today — no need to compare times.
    return false;
  }

  const nowMinutes = hour * 60 + minute;
  const openMinutes = timeToMinutes(hours.openingTime);
  const closeMinutes = timeToMinutes(hours.closingTime);
  if (openMinutes === null || closeMinutes === null) return null;

  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}

function toPublicBusiness(business: {
  id: string;
  name: string;
  type: string;
  timezone: string;
  hoursAndServices: string | null;
  allocatedPhone: string | null;
  allocatedPhoneSid: string | null;
  onboardingState: { completed: boolean } | null;
}) {
  const hours = parseHours(business.hoursAndServices);
  // Mwakire's customer app talks to the AI receptionist over an in-app
  // WebRTC call (see src/calls/), which needs no Twilio number at all — so
  // availability is "this business finished setting up its AI" (completed
  // onboarding), not "a phone number was provisioned." allocatedPhoneSid
  // now only matters for the legacy Twilio inbound-call path, which is
  // unrelated to what a customer sees here.
  const aiReceptionistAvailable = Boolean(business.onboardingState?.completed);

  return {
    id: business.id,
    name: business.name,
    type: business.type,
    hours: hours ? { selectedDays: hours.selectedDays, openingTime: hours.openingTime, closingTime: hours.closingTime } : null,
    isOpenNow: computeIsOpenNow(hours, business.timezone),
    aiReceptionistAvailable,
  };
}

const PUBLIC_SELECT = {
  id: true,
  name: true,
  type: true,
  timezone: true,
  hoursAndServices: true,
  allocatedPhone: true,
  allocatedPhoneSid: true,
  onboardingState: { select: { completed: true } },
} as const;

export const listBusinesses = async (req: Request, res: Response) => {
  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : DEFAULT_LIST_LIMIT;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
  const skipRaw = typeof req.query.skip === 'string' ? parseInt(req.query.skip, 10) : 0;
  const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? skipRaw : 0;

  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';

  const businesses = await prisma.business.findMany({
    where: category ? { type: { contains: category } } : undefined,
    select: PUBLIC_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip,
  });

  return res.json({ businesses: businesses.map(toPublicBusiness) });
};

export const searchBusinesses = async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (!q) {
    return res.json({ businesses: [] });
  }

  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : DEFAULT_LIST_LIMIT;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;

  const businesses = await prisma.business.findMany({
    where: {
      OR: [{ name: { contains: q } }, { type: { contains: q } }],
    },
    select: PUBLIC_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return res.json({ businesses: businesses.map(toPublicBusiness) });
};

export const getBusinessPublic = async (req: Request, res: Response) => {
  const { id } = req.params;

  const business = await prisma.business.findUnique({ where: { id }, select: PUBLIC_SELECT });

  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  return res.json(toPublicBusiness(business));
};
