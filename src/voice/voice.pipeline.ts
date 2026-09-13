import { generateLiveResponse } from '../services/aiCallService';
import {
  appendUserMessage,
  appendAssistantMessage,
  getMessages,
} from '../services/callSessionService';
import { AudioTransport } from './audio-transport';
import { SpeechToText, GroqSpeechToText } from './speech-to-text';
import { TextToSpeech, GoogleCloudTextToSpeech, GeminiTextToSpeech, FallbackTextToSpeech } from './text-to-speech';

const defaultTts = (): TextToSpeech => new FallbackTextToSpeech([new GoogleCloudTextToSpeech(), new GeminiTextToSpeech()]);

export type PipelineTurnState = 'listening' | 'thinking' | 'speaking';

/**
 * Wires one call's AudioTransport to the EXISTING AI receptionist brain
 * (aiCallService.generateLiveResponse, unmodified) and the EXISTING
 * per-call conversation state (callSessionService, unmodified — it was
 * already keyed by a generic string ID, not Twilio-specific, so app calls
 * reuse it as-is). This class owns none of the AI logic itself: audio in,
 * text through the existing brain, audio out.
 *
 * NOT YET EXERCISED end-to-end — no AudioTransport implementation feeds it
 * real customer audio yet (see calls/call.gateway.ts). The turn-taking
 * logic below is written to be correct once one does, and is unit-testable
 * today with a fake AudioTransport/STT/TTS.
 */
export class VoicePipeline {
  private currentTurn: Promise<void> = Promise.resolve();
  private cancelled = false;

  constructor(
    private readonly callSid: string,
    private readonly businessId: string,
    private readonly transport: AudioTransport,
    private readonly onStateChange: (state: PipelineTurnState) => void,
    private readonly stt: SpeechToText = new GroqSpeechToText(),
    private readonly tts: TextToSpeech = defaultTts()
  ) {
    this.transport.onCustomerAudio((audio, mimeType) => this.handleCustomerAudio(audio, mimeType));
  }

  /** Barge-in: called when new customer audio arrives while the AI is
   * still speaking. Kept intentionally simple for the first iteration —
   * it stops playback and lets the next turn start fresh, rather than
   * trying to splice a partial AI utterance back into the transcript. */
  async handleBargeIn(): Promise<void> {
    await this.transport.stopPlayback();
  }

  private handleCustomerAudio(audio: Buffer, mimeType: string): void {
    // Serialize turns: a second utterance arriving mid-turn interrupts
    // playback (barge-in) but still waits for the in-flight STT/AI/TTS
    // work to settle before starting, so two turns never race on the same
    // conversation history.
    this.currentTurn = this.currentTurn
      .then(() => this.handleBargeIn())
      .then(() => this.runTurn(audio, mimeType))
      .catch((error) => {
        console.error('[voice] Pipeline turn failed.', {
          callSid: this.callSid,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async runTurn(audio: Buffer, mimeType: string): Promise<void> {
    if (this.cancelled) return;

    this.onStateChange('listening');
    const text = await this.stt.transcribeChunk(audio, mimeType);
    console.log('[voice] STT transcript.', { callSid: this.callSid, length: text.length });
    if (this.cancelled || !text.trim()) {
      console.log('[voice] Empty/whitespace transcript — skipping this turn.', { callSid: this.callSid });
      return;
    }

    appendUserMessage(this.callSid, text);

    this.onStateChange('thinking');
    const reply = await generateLiveResponse(this.businessId, getMessages(this.callSid));
    if (this.cancelled) return;

    appendAssistantMessage(this.callSid, reply);
    console.log('[voice] AI reply generated.', { callSid: this.callSid, length: reply.length });

    this.onStateChange('speaking');
    const { audio: replyAudio, mimeType: replyMimeType } = await this.tts.synthesize(reply);
    if (this.cancelled) return;

    await this.transport.sendAudioToCustomer(replyAudio, replyMimeType);
    console.log('[voice] AI audio sent to customer.', { callSid: this.callSid, bytes: replyAudio.length });
  }

  /** Stops accepting/producing further turns. Does not close the
   * transport itself — call.service.ts owns that lifecycle. */
  dispose(): void {
    this.cancelled = true;
  }
}
