/**
 * A deliberately simple energy-based voice activity detector — turn
 * detection for the first iteration, per the architecture note: LiveKit's
 * Node SDK (@livekit/rtc-node) hands back raw PCM frames with no VAD of
 * its own (that only exists in the much heavier @livekit/agents
 * framework), so this is the smallest correct thing that avoids sending
 * every 10-20ms audio frame to Groq individually. Pure and dependency-free
 * — no reason this can't be swapped for a real model (e.g. Silero) later
 * without touching anything that calls it.
 */
export interface VadOptions {
  /** RMS amplitude (0-32767 scale) above which a frame counts as speech. */
  speechRmsThreshold?: number;
  /** How much trailing silence after speech ends an utterance. */
  silenceHangoverMs?: number;
  /** Utterances shorter than this are discarded as noise, not transcribed. */
  minUtteranceMs?: number;
  /** Hard cap so one continuous stream of speech can't buffer forever. */
  maxUtteranceMs?: number;
}

const DEFAULTS: Required<VadOptions> = {
  speechRmsThreshold: 600,
  silenceHangoverMs: 700,
  minUtteranceMs: 250,
  maxUtteranceMs: 15_000,
};

export class UtteranceDetector {
  private readonly opts: Required<VadOptions>;
  private buffered: Int16Array[] = [];
  private speaking = false;
  private msBuffered = 0;
  private msSinceSpeech = 0;

  constructor(opts: VadOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Feed one frame of PCM16 mono audio. Returns a completed utterance
   * (concatenated PCM16 samples) once enough trailing silence follows
   * speech, or the max length is hit — otherwise null. */
  pushFrame(data: Int16Array, sampleRate: number): Int16Array | null {
    const durationMs = (data.length / sampleRate) * 1000;
    const isSpeech = computeRms(data) >= this.opts.speechRmsThreshold;

    if (!isSpeech && !this.speaking) {
      return null; // silence before any speech has started
    }

    if (isSpeech) {
      this.speaking = true;
      this.msSinceSpeech = 0;
    } else {
      this.msSinceSpeech += durationMs;
    }

    this.buffered.push(data);
    this.msBuffered += durationMs;

    if (this.msSinceSpeech >= this.opts.silenceHangoverMs || this.msBuffered >= this.opts.maxUtteranceMs) {
      return this.flush();
    }

    return null;
  }

  /** Forces out whatever has been buffered so far (e.g. the call is
   * ending) even if trailing silence hasn't elapsed. Returns null if
   * there's nothing long enough to be worth transcribing. */
  flush(): Int16Array | null {
    const longEnough = this.msBuffered >= this.opts.minUtteranceMs;
    const utterance = longEnough && this.buffered.length > 0 ? concatInt16(this.buffered) : null;

    this.buffered = [];
    this.msBuffered = 0;
    this.msSinceSpeech = 0;
    this.speaking = false;

    return utterance;
  }
}

function computeRms(data: Int16Array): number {
  if (data.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
  return Math.sqrt(sumSquares / data.length);
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
