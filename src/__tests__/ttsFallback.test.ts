import { FallbackTextToSpeech, TextToSpeech } from '../voice/text-to-speech';

function fakeProvider(result: { audio: Buffer; mimeType: string } | Error): TextToSpeech {
  return {
    synthesize: jest.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('FallbackTextToSpeech', () => {
  it('uses the first provider when it succeeds, never calling the second', async () => {
    const primary = fakeProvider({ audio: Buffer.from('primary'), mimeType: 'audio/wav' });
    const secondary = fakeProvider({ audio: Buffer.from('secondary'), mimeType: 'audio/wav' });

    const tts = new FallbackTextToSpeech([primary, secondary]);
    const result = await tts.synthesize('hello');

    expect(result.audio.toString()).toBe('primary');
    expect(secondary.synthesize).not.toHaveBeenCalled();
  });

  it('falls through to the second provider when the first fails (e.g. quota exceeded)', async () => {
    const primary = fakeProvider(new Error('Google Cloud speech synthesis failed (429): quota exceeded'));
    const secondary = fakeProvider({ audio: Buffer.from('fallback-audio'), mimeType: 'audio/wav' });

    const tts = new FallbackTextToSpeech([primary, secondary]);
    const result = await tts.synthesize('hello');

    expect(result.audio.toString()).toBe('fallback-audio');
  });

  it('throws the last error when every provider fails', async () => {
    const primary = fakeProvider(new Error('primary down'));
    const secondary = fakeProvider(new Error('secondary down too'));

    const tts = new FallbackTextToSpeech([primary, secondary]);

    await expect(tts.synthesize('hello')).rejects.toThrow('secondary down too');
  });

  it('retries from the first provider again on the next call (no permanent demotion)', async () => {
    const primary = fakeProvider(new Error('transient failure'));
    const secondary = fakeProvider({ audio: Buffer.from('ok'), mimeType: 'audio/wav' });
    const tts = new FallbackTextToSpeech([primary, secondary]);

    await tts.synthesize('first call');
    await tts.synthesize('second call');

    // Both calls should have tried the primary provider first.
    expect(primary.synthesize).toHaveBeenCalledTimes(2);
  });

  it('requires at least one provider', () => {
    expect(() => new FallbackTextToSpeech([])).toThrow();
  });
});
