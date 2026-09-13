import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  PORT: process.env.PORT || 4000,
  DATABASE_URL: process.env.DATABASE_URL || "file:./dev.db",
  JWT_SECRET: process.env.JWT_SECRET || "fallback-secret-key",
  // Telephony (Twilio). No fallback values on purpose: an absent value must
  // fail closed in the signature-verification middleware, never silently
  // validate against a fake default.
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  // How long an in-memory CallSession may sit idle before the maintenance
  // sweep considers it abandoned and removes it. See callSessionService.ts.
  CALL_SESSION_TIMEOUT_MINUTES: Number(process.env.CALL_SESSION_TIMEOUT_MINUTES) || 30,
  // LiveKit Cloud (in-app WebRTC audio transport for Mwakire calls). No
  // fallback values on purpose — call.service.ts must fail closed with a
  // clear "not configured" response rather than mint a token against a
  // fake project. See src/calls/README or the app-call architecture notes.
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
  LIVEKIT_URL: process.env.LIVEKIT_URL,
  // Gemini API (in-app call TTS) — genuinely free within rate limits via
  // Google AI Studio, no credit card required. Groq's own TTS (playai-tts)
  // was decommissioned by Groq; a paid ElevenLabs integration was tried
  // next; this replaced it at the user's request. See
  // voice/text-to-speech.ts. No fallback value on purpose: an absent key
  // must fail closed with a clear "not configured" error.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  // Preview model name/voice — kept overridable since Google has already
  // renamed this model once (2.5 -> 3.1 preview) with no deprecation
  // window guaranteed.
  GEMINI_TTS_MODEL: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
  GEMINI_TTS_VOICE: process.env.GEMINI_TTS_VOICE || 'Kore',
  // Google Cloud Text-to-Speech (the actual Cloud product, not the Gemini/
  // AI Studio preview) — primary TTS provider for its much larger free
  // quota. Needs a billing-enabled GCP project; see .env.example.
  GOOGLE_TTS_API_KEY: process.env.GOOGLE_TTS_API_KEY,
  GOOGLE_TTS_VOICE_NAME: process.env.GOOGLE_TTS_VOICE_NAME || 'en-US-Standard-C',
  GOOGLE_TTS_LANGUAGE_CODE: process.env.GOOGLE_TTS_LANGUAGE_CODE || 'en-US',
};