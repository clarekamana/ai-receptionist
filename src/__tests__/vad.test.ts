import { UtteranceDetector } from '../voice/vad';

const SAMPLE_RATE = 16000;

/** A frame of pure silence (near-zero amplitude) of the given duration. */
function silenceFrame(ms: number): Int16Array {
  return new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

/** A frame of loud enough "speech" (well above the default RMS threshold). */
function speechFrame(ms: number): Int16Array {
  const frame = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let i = 0; i < frame.length; i++) {
    frame[i] = i % 2 === 0 ? 12000 : -12000;
  }
  return frame;
}

describe('UtteranceDetector (VAD)', () => {
  it('never emits an utterance from silence alone', () => {
    const vad = new UtteranceDetector();
    for (let i = 0; i < 20; i++) {
      expect(vad.pushFrame(silenceFrame(20), SAMPLE_RATE)).toBeNull();
    }
  });

  it('emits the buffered utterance once speech is followed by enough trailing silence', () => {
    const vad = new UtteranceDetector({ silenceHangoverMs: 200, minUtteranceMs: 100 });

    expect(vad.pushFrame(speechFrame(300), SAMPLE_RATE)).toBeNull();

    // Not enough silence yet.
    expect(vad.pushFrame(silenceFrame(100), SAMPLE_RATE)).toBeNull();

    // Crosses the 200ms silence-hangover threshold.
    const utterance = vad.pushFrame(silenceFrame(150), SAMPLE_RATE);
    expect(utterance).not.toBeNull();
    // The utterance includes the speech AND the buffered trailing silence.
    expect(utterance!.length).toBe(Math.round((SAMPLE_RATE * (300 + 100 + 150)) / 1000));
  });

  it('discards an utterance shorter than minUtteranceMs (treats it as noise)', () => {
    const vad = new UtteranceDetector({ silenceHangoverMs: 100, minUtteranceMs: 500 });

    vad.pushFrame(speechFrame(50), SAMPLE_RATE);
    const utterance = vad.pushFrame(silenceFrame(150), SAMPLE_RATE);

    expect(utterance).toBeNull();
  });

  it('forces a flush once maxUtteranceMs is reached, even without silence', () => {
    const vad = new UtteranceDetector({ maxUtteranceMs: 500, minUtteranceMs: 100 });

    expect(vad.pushFrame(speechFrame(300), SAMPLE_RATE)).toBeNull();
    const utterance = vad.pushFrame(speechFrame(300), SAMPLE_RATE);

    expect(utterance).not.toBeNull();
  });

  it('resets cleanly after emitting, ready to detect the next utterance', () => {
    const vad = new UtteranceDetector({ silenceHangoverMs: 100, minUtteranceMs: 50 });

    vad.pushFrame(speechFrame(200), SAMPLE_RATE);
    const first = vad.pushFrame(silenceFrame(150), SAMPLE_RATE);
    expect(first).not.toBeNull();

    // Silence right after a flush must not immediately re-trigger.
    expect(vad.pushFrame(silenceFrame(50), SAMPLE_RATE)).toBeNull();

    vad.pushFrame(speechFrame(200), SAMPLE_RATE);
    const second = vad.pushFrame(silenceFrame(150), SAMPLE_RATE);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('flush() manually forces out a long-enough buffered utterance (e.g. on call end)', () => {
    const vad = new UtteranceDetector({ minUtteranceMs: 100 });
    vad.pushFrame(speechFrame(300), SAMPLE_RATE);

    const utterance = vad.flush();
    expect(utterance).not.toBeNull();
  });

  it('flush() returns null when nothing long enough was buffered', () => {
    const vad = new UtteranceDetector({ minUtteranceMs: 500 });
    vad.pushFrame(speechFrame(50), SAMPLE_RATE);

    expect(vad.flush()).toBeNull();
  });
});
