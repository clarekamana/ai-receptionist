import { decodeWav, encodeWavMono16 } from '../voice/wav';

describe('wav encode/decode', () => {
  it('round-trips PCM16 mono samples exactly', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768, -1, 12345]);
    const wav = encodeWavMono16(samples, 16000);

    const decoded = decodeWav(wav);

    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(Array.from(decoded.samples)).toEqual(Array.from(samples));
  });

  it('preserves a different sample rate', () => {
    const samples = new Int16Array([100, -100, 200, -200]);
    const wav = encodeWavMono16(samples, 24000);

    expect(decodeWav(wav).sampleRate).toBe(24000);
  });

  it('produces a canonical 44-byte-header WAV with the correct data size', () => {
    const samples = new Int16Array(10);
    const wav = encodeWavMono16(samples, 16000);

    expect(wav.length).toBe(44 + 20);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  });

  it('throws on a buffer that is not a WAV file at all', () => {
    expect(() => decodeWav(Buffer.from('not a wav file at all'))).toThrow();
  });

  it('throws on a truncated/corrupt buffer', () => {
    const wav = encodeWavMono16(new Int16Array([1, 2, 3]), 16000);
    expect(() => decodeWav(wav.subarray(0, 20))).toThrow();
  });
});
