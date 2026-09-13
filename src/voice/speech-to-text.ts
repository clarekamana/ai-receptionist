const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const STT_MODEL = 'whisper-large-v3-turbo';

const getApiKey = () => {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY environment variable is not defined.');
  return key;
};

/**
 * Converts audio into text. Deliberately an interface, not a concrete
 * function call site, so a genuinely-streaming implementation can replace
 * ChunkedGroqSpeechToText later without touching VoicePipeline or anything
 * upstream of it.
 *
 * NOT YET WIRED to any live audio source — nothing in this codebase calls
 * transcribeChunk() yet. It exists so the AudioTransport -> VoicePipeline
 * seam is real once a LiveKit-based transport starts handing it audio
 * frames. Untested against the live Groq endpoint (no network access in
 * this environment) — verify the request/response shape against Groq's
 * current API docs before relying on it.
 */
export interface SpeechToText {
  /** `audio` is a complete, decodable audio buffer (e.g. one utterance/turn
   * captured by the transport's voice-activity detection) — not a raw PCM
   * stream. `mimeType` must be one Groq's Whisper endpoint accepts
   * (e.g. 'audio/wav', 'audio/webm'). */
  transcribeChunk(audio: Buffer, mimeType: string): Promise<string>;
}

export class GroqSpeechToText implements SpeechToText {
  async transcribeChunk(audio: Buffer, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append('model', STT_MODEL);
    form.append('response_format', 'text');
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: mimeType }),
      `audio.${mimeType.split('/')[1] || 'wav'}`
    );

    const response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getApiKey()}` },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Groq transcription failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    return (await response.text()).trim();
  }
}
