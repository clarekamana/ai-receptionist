import { ENV } from '../config/env';
import { encodeWavMono16 } from './wav';

const getApiKey = () => {
  const key = ENV.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY environment variable is not defined.');
  return key;
};

/**
 * Converts AI receptionist text into speech audio. An interface (not a
 * bare function) so the concrete provider can be swapped without touching
 * VoicePipeline or anything upstream of it — this seam has already
 * outlived three provider changes: Groq's own TTS (playai-tts) was
 * decommissioned server-side by Groq (confirmed live via a 400
 * model_decommissioned response); a paid ElevenLabs integration was tried
 * next; Gemini replaced that as a genuinely free option but hit its free-
 * tier rate limit on real calls; Google Cloud TTS (below) is now primary
 * for its much larger free quota, with Gemini kept as an automatic
 * fallback via FallbackTextToSpeech. None of this touched call.gateway.ts
 * or voice.pipeline.ts beyond which concrete class(es) get constructed.
 */
export interface TextToSpeech {
  synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }>;
}

interface GeminiInlineData {
  mimeType?: string;
  data?: string;
}

/** Gemini's TTS mimeType looks like "audio/L16;codec=pcm;rate=24000" —
 * parses out the rate rather than assuming one, since LiveKitAudioTransport
 * already reads the actual rate from the WAV header and resamples
 * accordingly (see call.gateway.ts's sendAudioToCustomer). */
function parseSampleRate(mimeType: string | undefined, fallback: number): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? parseInt(match[1], 10) : fallback;
}

export class GeminiTextToSpeech implements TextToSpeech {
  // Google AI Studio's Gemini API: genuinely free within rate limits, no
  // credit card required (unlike Google Cloud TTS, which needs a
  // billing-enabled GCP project even for its "always free" tier). This is
  // a preview model — Google has already renamed/rotated it once (2.5 ->
  // 3.1) with no deprecation window guaranteed — kept overridable via
  // ENV rather than hardcoded, the same lesson aiCallService.ts's MODEL
  // taught when it broke outright with no warning.
  constructor(
    private readonly model: string = ENV.GEMINI_TTS_MODEL,
    private readonly voiceName: string = ENV.GEMINI_TTS_VOICE
  ) {}

  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': getApiKey(),
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } },
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini speech synthesis failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const inlineData: GeminiInlineData | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;

    if (!inlineData?.data) {
      throw new Error('Gemini speech synthesis returned no audio data.');
    }
    if (inlineData.mimeType && !inlineData.mimeType.startsWith('audio/L16') && !inlineData.mimeType.includes('pcm')) {
      // Never silently mis-decode a compressed format (e.g. MP3) as raw PCM.
      throw new Error(`Gemini returned an unsupported audio mimeType: "${inlineData.mimeType}".`);
    }

    const sampleRate = parseSampleRate(inlineData.mimeType, 24000);
    const pcmBytes = Buffer.from(inlineData.data, 'base64');
    const sampleCount = Math.floor(pcmBytes.length / 2);
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = pcmBytes.readInt16LE(i * 2);
    }

    return { audio: encodeWavMono16(samples, sampleRate), mimeType: 'audio/wav' };
  }
}

const getGoogleCloudApiKey = () => {
  const key = ENV.GOOGLE_TTS_API_KEY;
  if (!key) throw new Error('GOOGLE_TTS_API_KEY environment variable is not defined.');
  return key;
};

/**
 * Google Cloud's actual Text-to-Speech product (distinct from the Gemini/
 * AI Studio preview above) — chosen as the primary provider for its much
 * larger "always free" quota (~4M characters/month for Standard voices),
 * at the cost of needing a billing-enabled GCP project. Uses simple API-
 * key auth (`?key=`), not OAuth/a service-account JSON, to keep this a
 * plain REST call like every other provider in this file.
 *
 * For LINEAR16 encoding, Google's response already includes a full WAV
 * header (per its own API docs) — unlike Gemini/ElevenLabs, no manual WAV
 * wrapping is needed here at all.
 */
export class GoogleCloudTextToSpeech implements TextToSpeech {
  constructor(
    private readonly voiceName: string = ENV.GOOGLE_TTS_VOICE_NAME,
    private readonly languageCode: string = ENV.GOOGLE_TTS_LANGUAGE_CODE
  ) {}

  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${getGoogleCloudApiKey()}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: this.languageCode, name: this.voiceName },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 16000 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Google Cloud speech synthesis failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    if (!data?.audioContent) {
      throw new Error('Google Cloud speech synthesis returned no audio data.');
    }

    return { audio: Buffer.from(data.audioContent, 'base64'), mimeType: 'audio/wav' };
  }
}

/**
 * Tries each provider in order, only moving to the next on failure —
 * "bigger quota service, with a fallback" in one seam. A single call
 * failing over does NOT retry the ones before it; every synthesize() call
 * starts again from the first provider, so a transient failure never
 * permanently demotes a provider for the rest of the conversation.
 */
export class FallbackTextToSpeech implements TextToSpeech {
  constructor(private readonly providers: TextToSpeech[]) {
    if (providers.length === 0) throw new Error('FallbackTextToSpeech requires at least one provider.');
  }

  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        return await provider.synthesize(text);
      } catch (error) {
        lastError = error;
        console.warn('[voice] TTS provider failed, trying the next one.', {
          provider: provider.constructor.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All TTS providers failed.');
  }
}
