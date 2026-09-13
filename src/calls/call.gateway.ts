import { AccessToken } from 'livekit-server-sdk';
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteAudioTrack,
  AudioSource,
  AudioStream,
  AudioFrame,
  AudioResampler,
  combineAudioFrames,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  TrackKind,
} from '@livekit/rtc-node';
import { ENV } from '../config/env';
import { AudioTransport } from '../voice/audio-transport';
import { UtteranceDetector } from '../voice/vad';
import { decodeWav, encodeWavMono16 } from '../voice/wav';
import { VoicePipeline, PipelineTurnState } from '../voice/voice.pipeline';
import { toCallSid } from './call.types';

export function isLiveKitConfigured(): boolean {
  return Boolean(ENV.LIVEKIT_API_KEY && ENV.LIVEKIT_API_SECRET && ENV.LIVEKIT_URL);
}

function customerIdentity(callId: string): string {
  return `customer-${callId}`;
}

function agentIdentity(callId: string): string {
  return `mwakire-ai-${callId}`;
}

/**
 * Mints a LiveKit room-scoped access token for the customer's side of one
 * call. This is the entire "signaling" layer Mwakire's backend needs to
 * write by hand — LiveKit's own client/server SDKs handle the actual
 * WebRTC offer/answer/ICE exchange once the mobile app connects with this
 * token. Room name == callId, so ownership is enforced by construction: a
 * token for callId A can never join callId B's room.
 */
export async function createCustomerCallToken(callId: string, businessId: string): Promise<{ url: string; token: string }> {
  if (!isLiveKitConfigured()) {
    throw new Error('LiveKit is not configured (LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL missing).');
  }

  const at = new AccessToken(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET, {
    identity: customerIdentity(callId),
    ttl: '2h',
  });
  at.addGrant({
    room: callId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // The customer's client never needs to know the AI agent's internal
    // identity/metadata beyond its audio track.
    canPublishData: true,
  });

  return { url: ENV.LIVEKIT_URL as string, token: await at.toJwt() };
}

/** Server-only — never sent to the mobile app. Only this backend, holding
 * LIVEKIT_API_SECRET, can mint a token for the `mwakire-ai-{callId}`
 * identity, so a customer can never impersonate or join as the AI. */
async function createAgentToken(callId: string): Promise<string> {
  const at = new AccessToken(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET, {
    identity: agentIdentity(callId),
    ttl: '2h',
  });
  at.addGrant({ room: callId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

// LiveKit's own rtc-node README publishes at 16000/1 for exactly this kind
// of use case (a synthesized/non-microphone source); it's also Whisper's
// native rate, so the inbound path (AudioStream requesting this rate)
// needs no separate resample step before handing frames to Groq STT.
const TRANSPORT_SAMPLE_RATE = 16000;

/**
 * The AI receptionist's side of the room: a real server-side LiveKit
 * participant (via @livekit/rtc-node — LiveKit's own native Node SDK, not
 * a hand-rolled WebRTC/RTP stack) that subscribes to the customer's audio
 * track, runs simple energy-based turn detection (see voice/vad.ts) on the
 * raw PCM frames, and publishes synthesized speech back as its own audio
 * track. One instance per call; never shared across calls.
 */
class LiveKitAudioTransport implements AudioTransport {
  private readonly room = new Room();
  private readonly audioSource = new AudioSource(TRANSPORT_SAMPLE_RATE, 1);
  private readonly vad = new UtteranceDetector();
  private localTrack: LocalAudioTrack | null = null;
  private onAudioCallback: ((audio: Buffer, mimeType: string) => void) | null = null;
  private closed = false;
  // Guards against listening to the same customer track twice — the
  // TrackSubscribed listener (registered before connect) and the
  // defensive already-subscribed scan (run right after) can both observe
  // the same track for the exact race window they're each covering.
  private readonly listenedTrackSids = new Set<string>();

  constructor(private readonly callId: string) {}

  async connect(): Promise<void> {
    // Registered BEFORE room.connect() deliberately: with autoSubscribe
    // true, LiveKit delivers already-published tracks (e.g. the customer
    // published its mic before the agent even joined — the common case,
    // since the mobile client starts publishing immediately on connect)
    // as TrackSubscribed events fired during/immediately after connect()
    // resolves. A listener attached afterward can miss that first event
    // entirely and the agent would sit there hearing nothing, forever,
    // with no error anywhere — exactly what "customer talks, AI never
        // replies" looks like with no exception thrown.
    this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      console.log('[voice] TrackSubscribed.', {
        callId: this.callId,
        participantIdentity: participant.identity,
        kind: track.kind,
      });

      if (participant.identity !== customerIdentity(this.callId)) return; // never process audio from anyone but this call's customer
      if (track.kind !== TrackKind.KIND_AUDIO) return;

      this.listenToCustomerTrack(track as RemoteAudioTrack).catch((error) => {
        console.error('[voice] Failed reading customer audio stream.', {
          callId: this.callId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    const token = await createAgentToken(this.callId);
    console.log('[voice] Agent connecting to LiveKit room.', { callId: this.callId });
    await this.room.connect(ENV.LIVEKIT_URL as string, token, { autoSubscribe: true, dynacast: true });
    console.log('[voice] Agent connected to LiveKit room.', {
      callId: this.callId,
      remoteParticipants: [...this.room.remoteParticipants.keys()],
    });

    const track = LocalAudioTrack.createAudioTrack('mwakire-ai-voice', this.audioSource);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(track, options);
    this.localTrack = track;

    // Defense-in-depth for the same race: if the customer's audio track
    // was already fully subscribed by the time we got here (regardless of
    // whether TrackSubscribed already fired for it above), pick it up
    // directly rather than depend solely on the event having been seen.
    this.attachAnyAlreadySubscribedCustomerTrack();
  }

  private attachAnyAlreadySubscribedCustomerTrack(): void {
    const participant = this.room.remoteParticipants.get(customerIdentity(this.callId));
    if (!participant) return;

    for (const publication of participant.trackPublications.values()) {
      if (publication.kind === TrackKind.KIND_AUDIO && publication.track) {
        console.log('[voice] Picking up an already-subscribed customer audio track.', { callId: this.callId });
        this.listenToCustomerTrack(publication.track as RemoteAudioTrack).catch((error) => {
          console.error('[voice] Failed reading customer audio stream (already-subscribed path).', {
            callId: this.callId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  /** Resolves once the customer participant is present in the room —
   * immediately if already there, otherwise on the next ParticipantConnected
   * for this call's customer identity. Rejects on timeout, which the caller
   * treats as a connection failure rather than hanging forever. */
  waitForCustomer(timeoutMs = 30_000): Promise<void> {
    const identity = customerIdentity(this.callId);
    if (this.room.remoteParticipants.has(identity)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.room.off(RoomEvent.ParticipantConnected, onJoin);
        reject(new Error('Customer did not join the call in time.'));
      }, timeoutMs);

      const onJoin = (participant: RemoteParticipant) => {
        if (participant.identity !== identity) return;
        clearTimeout(timer);
        this.room.off(RoomEvent.ParticipantConnected, onJoin);
        resolve();
      };

      this.room.on(RoomEvent.ParticipantConnected, onJoin);
    });
  }

  /** Fires once if/when the customer participant leaves the room —
   * network drop, app killed, or a clean hangup that reached LiveKit
   * before it reached our own /end endpoint. */
  onCustomerDisconnected(callback: () => void): void {
    this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === customerIdentity(this.callId)) callback();
    });
  }

  private async listenToCustomerTrack(track: RemoteAudioTrack): Promise<void> {
    const sid = track.sid;
    if (sid) {
      if (this.listenedTrackSids.has(sid)) return; // already being read via the other detection path
      this.listenedTrackSids.add(sid);
    }

    console.log('[voice] Reading customer audio track.', { callId: this.callId, trackSid: sid });
    const stream = new AudioStream(track, TRANSPORT_SAMPLE_RATE, 1);
    let frameCount = 0;

    for await (const frame of stream) {
      if (this.closed) break;
      frameCount += 1;

      const utterance = this.vad.pushFrame(frame.data, frame.sampleRate);
      if (utterance && this.onAudioCallback) {
        console.log('[voice] VAD detected a complete utterance.', {
          callId: this.callId,
          samples: utterance.length,
        });
        this.onAudioCallback(encodeWavMono16(utterance, TRANSPORT_SAMPLE_RATE), 'audio/wav');
      }
    }

    console.log('[voice] Customer audio stream ended.', { callId: this.callId, framesRead: frameCount });
  }

  onCustomerAudio(callback: (audio: Buffer, mimeType: string) => void): void {
    this.onAudioCallback = callback;
  }

  /** Publishes a turn-state update ("listening"/"thinking"/"speaking") over
   * the room's data channel — the mobile call screen's useDataChannel('call-
   * state', ...) hook (app/call/[callId].tsx) is the reader on the other
   * end. Best-effort: a dropped state update never fails the call. */
  async publishState(state: PipelineTurnState): Promise<void> {
    if (this.closed || !this.room.localParticipant) return;
    const payload = new TextEncoder().encode(JSON.stringify({ state }));
    await this.room.localParticipant
      .publishData(payload, { topic: 'call-state', reliable: true })
      .catch(() => undefined);
  }

  async sendAudioToCustomer(audio: Buffer, mimeType: string): Promise<void> {
    if (this.closed) return;
    if (mimeType !== 'audio/wav') {
      throw new Error(`LiveKitAudioTransport only supports audio/wav TTS output, got "${mimeType}".`);
    }

    const { samples, sampleRate, channels } = decodeWav(audio);
    const mono = channels === 1 ? samples : downmixToMono(samples, channels);

    let outFrame: AudioFrame;
    if (sampleRate === TRANSPORT_SAMPLE_RATE) {
      outFrame = new AudioFrame(mono, sampleRate, 1, mono.length);
    } else {
      // Reuses rtc-node's own (Sox-backed) resampler rather than hand-
      // rolling one — the TTS provider's actual output rate is read from
      // its WAV header above, never assumed.
      const resampler = new AudioResampler(sampleRate, TRANSPORT_SAMPLE_RATE, 1);
      const frames = [...resampler.push(new AudioFrame(mono, sampleRate, 1, mono.length)), ...resampler.flush()];
      resampler.close();

      if (frames.length === 0) {
        console.warn('[voice] TTS audio resampled to zero frames — skipping playback for this turn.', {
          callId: this.callId,
        });
        return;
      }

      outFrame = combineAudioFrames(frames);
    }

    await this.audioSource.captureFrame(outFrame);
    await this.audioSource.waitForPlayout();
  }

  async stopPlayback(): Promise<void> {
    // VoicePipeline calls this unconditionally at the start of every turn
    // (barge-in) — including a turn whose audio arrives after the call has
    // already started tearing down (close() already released the native
    // AudioSource handle), which otherwise throws "handle not found" from
    // the FFI layer.
    if (this.closed) return;
    this.audioSource.clearQueue();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.localTrack?.close().catch(() => undefined);
    await this.audioSource.close().catch(() => undefined);
    await this.room.disconnect().catch(() => undefined);
  }
}

function downmixToMono(samples: Int16Array, channels: number): Int16Array {
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    mono[i] = Math.round(sum / channels);
  }
  return mono;
}

export interface VoiceAgentHooks {
  /** The customer has joined the room — safe to move the AppCall to CONNECTED/ACTIVE. */
  onConnected: () => void | Promise<void>;
  /** The customer participant left the LiveKit room on its own (network
   * drop, app killed, or a hangup that reached LiveKit before /end did). */
  onCustomerLeft: () => void | Promise<void>;
  /** The agent could not join/stay in the room at all. */
  onFailure: (reason: string) => void | Promise<void>;
}

interface ActiveAgent {
  transport: LiveKitAudioTransport;
  pipeline: VoicePipeline;
}

// One entry per in-progress call, for exactly as long as the call is live.
// This is what stopVoiceAgent() looks up to guarantee no zombie agent
// participant is ever left in a room after a call ends (see call.service.ts's
// finalizeCallLog, which calls stopVoiceAgent unconditionally).
const activeAgents = new Map<string, ActiveAgent>();

/**
 * Joins the AI receptionist into `callId`'s LiveKit room and wires it to
 * the EXISTING VoicePipeline (STT -> generateLiveResponse -> TTS) —
 * nothing here implements AI logic itself. Idempotent: a second call for
 * an already-active callId is a no-op.
 */
export async function startVoiceAgent(callId: string, businessId: string, hooks: VoiceAgentHooks): Promise<void> {
  if (activeAgents.has(callId)) {
    console.log('[app-calls] startVoiceAgent called again for an already-active call — ignoring.', { callId });
    return;
  }

  console.log('[app-calls] Starting voice agent.', { callId, businessId });
  const transport = new LiveKitAudioTransport(callId);

  try {
    await transport.connect();
  } catch (error) {
    console.error('[app-calls] Voice agent failed to connect to LiveKit.', {
      callId,
      message: error instanceof Error ? error.message : String(error),
    });
    await transport.close().catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }

  const pipeline = new VoicePipeline(toCallSid(callId), businessId, transport, (state) => {
    transport.publishState(state).catch(() => undefined);
  });

  activeAgents.set(callId, { transport, pipeline });
  transport.onCustomerDisconnected(() => hooks.onCustomerLeft());

  try {
    await transport.waitForCustomer();
  } catch (error) {
    console.error('[app-calls] Voice agent gave up waiting for the customer to join.', {
      callId,
      message: error instanceof Error ? error.message : String(error),
    });
    await stopVoiceAgent(callId);
    await hooks.onFailure(error instanceof Error ? error.message : String(error));
    return;
  }

  console.log('[app-calls] Voice agent sees the customer in the room — call is active.', { callId });
  await hooks.onConnected();
}

/** Tears down this call's agent (pipeline + LiveKit participant), if any.
 * Always safe to call, including for a callId with no active agent — the
 * common "LiveKit was never configured" / "agent never joined" path. */
export async function stopVoiceAgent(callId: string): Promise<void> {
  const entry = activeAgents.get(callId);
  if (!entry) return;

  activeAgents.delete(callId);
  entry.pipeline.dispose();
  await entry.transport.close().catch(() => undefined);
}

/** Test-only: how many agents are currently tracked as active. */
export function activeVoiceAgentCount(): number {
  return activeAgents.size;
}
