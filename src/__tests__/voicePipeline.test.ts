import { VoicePipeline, PipelineTurnState } from '../voice/voice.pipeline';
import { AudioTransport } from '../voice/audio-transport';
import { SpeechToText } from '../voice/speech-to-text';
import { TextToSpeech } from '../voice/text-to-speech';
import { generateLiveResponse } from '../services/aiCallService';
import { getOrCreateSession, getMessages, deleteSession } from '../services/callSessionService';

// VoicePipeline's whole point is "audio in, existing AI brain, audio out" —
// generateLiveResponse is Groq-backed and already covered elsewhere, so it's
// mocked here (same pattern as telephony.test.ts) to keep this suite fast,
// offline, and focused on the turn-taking/wiring logic this file owns.
jest.mock('../services/aiCallService', () => ({
  ...jest.requireActual('../services/aiCallService'),
  generateLiveResponse: jest.fn(),
}));

const mockGenerateLiveResponse = generateLiveResponse as jest.Mock;

class FakeAudioTransport implements AudioTransport {
  private callback: ((audio: Buffer, mimeType: string) => void) | null = null;
  sentAudio: { audio: Buffer; mimeType: string }[] = [];
  stopPlaybackCalls = 0;
  closed = false;

  onCustomerAudio(callback: (audio: Buffer, mimeType: string) => void): void {
    this.callback = callback;
  }

  /** Test helper: simulates the transport having detected a complete
   * customer utterance (what a real VAD-backed transport would deliver). */
  simulateCustomerUtterance(audio: Buffer, mimeType = 'audio/wav'): void {
    this.callback?.(audio, mimeType);
  }

  async sendAudioToCustomer(audio: Buffer, mimeType: string): Promise<void> {
    this.sentAudio.push({ audio, mimeType });
  }

  async stopPlayback(): Promise<void> {
    this.stopPlaybackCalls += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSpeechToText implements SpeechToText {
  constructor(private readonly result: string | Error = 'Are you open today?') {}
  async transcribeChunk(): Promise<string> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

class FakeTextToSpeech implements TextToSpeech {
  constructor(private readonly result: { audio: Buffer; mimeType: string } | Error = {
    audio: Buffer.from('fake-audio'),
    mimeType: 'audio/wav',
  }) {}
  async synthesize(): Promise<{ audio: Buffer; mimeType: string }> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function waitForTurn() {
  // The pipeline chains work off a private Promise with no external hook —
  // flushing microtasks a few times is enough for the awaited STT/AI/TTS
  // steps (all synchronously-resolving fakes here) to settle.
  return new Promise((resolve) => setImmediate(resolve));
}

describe('VoicePipeline', () => {
  const callSid = 'app_voice-pipeline-test';

  beforeEach(() => {
    mockGenerateLiveResponse.mockReset();
    getOrCreateSession({ callSid, businessId: 'biz-1', customerPhone: 'app:test' });
  });

  afterEach(() => {
    deleteSession(callSid);
  });

  it('runs a full turn: STT -> existing AI -> TTS -> transport, in order', async () => {
    mockGenerateLiveResponse.mockResolvedValue("Yes, we're open until 6pm.");
    const transport = new FakeAudioTransport();
    const states: PipelineTurnState[] = [];

    new VoicePipeline(
      callSid,
      'biz-1',
      transport,
      (state) => states.push(state),
      new FakeSpeechToText('Are you open today?'),
      new FakeTextToSpeech({ audio: Buffer.from('reply-audio'), mimeType: 'audio/wav' })
    );

    transport.simulateCustomerUtterance(Buffer.from('fake-customer-audio'));
    await waitForTurn();
    await waitForTurn();

    expect(states).toEqual(['listening', 'thinking', 'speaking']);
    expect(mockGenerateLiveResponse).toHaveBeenCalledWith('biz-1', expect.any(Array));
    expect(transport.sentAudio).toHaveLength(1);
    expect(transport.sentAudio[0].audio.toString()).toBe('reply-audio');

    const messages = getMessages(callSid);
    expect(messages).toEqual([
      { role: 'user', content: 'Are you open today?' },
      { role: 'assistant', content: "Yes, we're open until 6pm." },
    ]);
  });

  it('gives the AI the growing conversation history across multiple turns', async () => {
    // getMessages() returns a live reference into callSessionService's
    // session, so it must be snapshotted (copied) at call time — asserting
    // on it later would see later turns' mutations too.
    const historySnapshots: any[] = [];
    mockGenerateLiveResponse.mockImplementation(async (_businessId: string, messages: any[]) => {
      historySnapshots.push([...messages]);
      return historySnapshots.length === 1 ? 'Hello! How can I help?' : 'We open at 9am.';
    });
    const transport = new FakeAudioTransport();

    new VoicePipeline(
      callSid,
      'biz-1',
      transport,
      () => undefined,
      new FakeSpeechToText('Hi'),
      new FakeTextToSpeech()
    );

    transport.simulateCustomerUtterance(Buffer.from('turn-1'));
    await waitForTurn();
    await waitForTurn();

    // Second turn says something different — reuse the same pipeline/STT by
    // constructing a second one bound to the same callSid's session, mirroring
    // that the real transport keeps calling the same onCustomerAudio callback.
    (transport as any).callback = null;
    const secondStt = new FakeSpeechToText('What time do you open?');
    new VoicePipeline(callSid, 'biz-1', transport, () => undefined, secondStt, new FakeTextToSpeech());
    transport.simulateCustomerUtterance(Buffer.from('turn-2'));
    await waitForTurn();
    await waitForTurn();

    expect(historySnapshots[1]).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
      { role: 'user', content: 'What time do you open?' },
    ]);
    // ...and by the time the second turn finishes, its own reply is appended too.
    expect(getMessages(callSid)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
      { role: 'user', content: 'What time do you open?' },
      { role: 'assistant', content: 'We open at 9am.' },
    ]);
  });

  it('does not call the AI or TTS when STT fails, and does not crash', async () => {
    const transport = new FakeAudioTransport();

    new VoicePipeline(
      callSid,
      'biz-1',
      transport,
      () => undefined,
      new FakeSpeechToText(new Error('Groq transcription failed')),
      new FakeTextToSpeech()
    );

    transport.simulateCustomerUtterance(Buffer.from('audio'));
    await waitForTurn();
    await waitForTurn();

    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();
    expect(transport.sentAudio).toHaveLength(0);
    expect(getMessages(callSid)).toEqual([]);
  });

  it('does not call TTS when the AI fails, and does not crash', async () => {
    mockGenerateLiveResponse.mockRejectedValue(new Error('Groq is down'));
    const transport = new FakeAudioTransport();
    const ttsSpy = jest.fn();

    class SpyTts implements TextToSpeech {
      async synthesize() {
        ttsSpy();
        return { audio: Buffer.from('x'), mimeType: 'audio/wav' };
      }
    }

    new VoicePipeline(callSid, 'biz-1', transport, () => undefined, new FakeSpeechToText('Hello'), new SpyTts());

    transport.simulateCustomerUtterance(Buffer.from('audio'));
    await waitForTurn();
    await waitForTurn();

    expect(ttsSpy).not.toHaveBeenCalled();
    expect(transport.sentAudio).toHaveLength(0);
    // The user's turn is still recorded even though the AI failed to reply.
    expect(getMessages(callSid)).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('does not crash and leaves nothing sent when TTS fails', async () => {
    mockGenerateLiveResponse.mockResolvedValue('Some reply.');
    const transport = new FakeAudioTransport();

    new VoicePipeline(
      callSid,
      'biz-1',
      transport,
      () => undefined,
      new FakeSpeechToText('Hello'),
      new FakeTextToSpeech(new Error('Groq TTS failed'))
    );

    transport.simulateCustomerUtterance(Buffer.from('audio'));
    await waitForTurn();
    await waitForTurn();

    expect(transport.sentAudio).toHaveLength(0);
    // The assistant's reply is still recorded in history even though the
    // audio never made it out — the transcript stays accurate.
    expect(getMessages(callSid)).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Some reply.' },
    ]);
  });

  it('ignores empty/whitespace-only transcripts without calling the AI', async () => {
    const transport = new FakeAudioTransport();

    new VoicePipeline(callSid, 'biz-1', transport, () => undefined, new FakeSpeechToText('   '), new FakeTextToSpeech());

    transport.simulateCustomerUtterance(Buffer.from('silence-that-slipped-through'));
    await waitForTurn();
    await waitForTurn();

    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();
  });

  it('barge-in: stops playback before starting the next turn', async () => {
    mockGenerateLiveResponse.mockResolvedValue('Reply.');
    const transport = new FakeAudioTransport();

    new VoicePipeline(callSid, 'biz-1', transport, () => undefined, new FakeSpeechToText('Hi'), new FakeTextToSpeech());

    transport.simulateCustomerUtterance(Buffer.from('turn-1'));
    await waitForTurn();
    await waitForTurn();

    transport.simulateCustomerUtterance(Buffer.from('turn-2 (interrupting)'));
    await waitForTurn();
    await waitForTurn();

    // Called once per turn (including the first, where it's a harmless no-op).
    expect(transport.stopPlaybackCalls).toBe(2);
  });

  it('dispose() stops producing further turns', async () => {
    const transport = new FakeAudioTransport();
    const pipeline = new VoicePipeline(
      callSid,
      'biz-1',
      transport,
      () => undefined,
      new FakeSpeechToText('Hello'),
      new FakeTextToSpeech()
    );

    pipeline.dispose();
    transport.simulateCustomerUtterance(Buffer.from('audio'));
    await waitForTurn();
    await waitForTurn();

    expect(mockGenerateLiveResponse).not.toHaveBeenCalled();
    expect(transport.sentAudio).toHaveLength(0);
  });
});
