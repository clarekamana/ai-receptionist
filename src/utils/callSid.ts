/**
 * Extracts and validates Twilio's CallSid from a webhook body. Isolated here
 * because Phase 4B will use CallSid as the key for per-call conversation
 * state — keeping the extraction logic in one reusable place now avoids
 * duplicating it once that state layer exists.
 */
export function extractCallSid(body: Record<string, any> | undefined): string | null {
  const value = body?.CallSid;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
