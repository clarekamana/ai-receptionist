/**
 * The seam between "however audio actually gets to/from the customer's
 * phone" and the voice pipeline (STT -> AI -> TTS). VoicePipeline only ever
 * talks to this interface — it has no idea whether the concrete
 * implementation is LiveKit, a different SFU, or (in tests) an in-memory
 * fake. This is what "transport independent from the AI receptionist"
 * means architecturally in this codebase.
 */
export interface AudioTransport {
  /** Registers the callback invoked whenever a complete utterance of
   * customer audio is available to transcribe. */
  onCustomerAudio(callback: (audio: Buffer, mimeType: string) => void): void;

  /** Sends synthesized AI speech audio out to the customer. */
  sendAudioToCustomer(audio: Buffer, mimeType: string): Promise<void>;

  /** Interrupts any audio currently being played to the customer — the
   * hook barge-in support attaches to (see VoicePipeline.handleBargeIn). */
  stopPlayback(): Promise<void>;

  /** Tears down the underlying media connection. Must be safe to call more
   * than once (e.g. both "user ended call" and "AI failure" paths). */
  close(): Promise<void>;
}
