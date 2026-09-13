import { TokenVerifier } from 'livekit-server-sdk';
import { isLiveKitConfigured, createCustomerCallToken, activeVoiceAgentCount } from '../calls/call.gateway';
import { ENV } from '../config/env';

/**
 * Covers what's genuinely testable offline: token minting and room/identity
 * scoping (pure JWT signing — no network). Actually joining a LiveKit room
 * (LiveKitAudioTransport.connect(), startVoiceAgent()) requires a real or
 * mock LiveKit server and is NOT exercised here — see the final report's
 * "requires real device/LiveKit project" section.
 */
describe('call.gateway — LiveKit token scoping', () => {
  const originalKey = ENV.LIVEKIT_API_KEY;
  const originalSecret = ENV.LIVEKIT_API_SECRET;
  const originalUrl = ENV.LIVEKIT_URL;

  beforeEach(() => {
    (ENV as any).LIVEKIT_API_KEY = 'test-livekit-key';
    (ENV as any).LIVEKIT_API_SECRET = 'test-livekit-secret';
    (ENV as any).LIVEKIT_URL = 'wss://test.livekit.cloud';
  });

  afterEach(() => {
    (ENV as any).LIVEKIT_API_KEY = originalKey;
    (ENV as any).LIVEKIT_API_SECRET = originalSecret;
    (ENV as any).LIVEKIT_URL = originalUrl;
  });

  it('reports configured only when all three LiveKit env vars are present', () => {
    expect(isLiveKitConfigured()).toBe(true);

    (ENV as any).LIVEKIT_API_KEY = undefined;
    expect(isLiveKitConfigured()).toBe(false);
  });

  it('mints a customer token scoped to exactly the requested room (callId)', async () => {
    const { token, url } = await createCustomerCallToken('call-A', 'biz-1');
    expect(url).toBe('wss://test.livekit.cloud');

    const verifier = new TokenVerifier(ENV.LIVEKIT_API_KEY as string, ENV.LIVEKIT_API_SECRET as string);
    const grants = await verifier.verify(token);

    expect(grants.video?.room).toBe('call-A');
    expect(grants.video?.roomJoin).toBe(true);
    // Identity is carried in the standard JWT `sub` claim, per LiveKit's
    // token format (see AccessToken's own upstream test suite).
    expect(grants.sub).toBe('customer-call-A');
  });

  it('mints structurally different tokens/rooms for different calls (no cross-call access)', async () => {
    const tokenA = await createCustomerCallToken('call-A', 'biz-1');
    const tokenB = await createCustomerCallToken('call-B', 'biz-1');

    const verifier = new TokenVerifier(ENV.LIVEKIT_API_KEY as string, ENV.LIVEKIT_API_SECRET as string);
    const grantsA = await verifier.verify(tokenA.token);
    const grantsB = await verifier.verify(tokenB.token);

    expect(grantsA.video?.room).not.toBe(grantsB.video?.room);
    // A real LiveKit server enforces the room grant itself — this
    // confirms the token we mint can never claim access to another call's
    // room, which is the actual security boundary (see call.gateway.ts).
    expect(grantsA.video?.room).toBe('call-A');
    expect(grantsB.video?.room).toBe('call-B');
  });

  it('refuses to mint a token when LiveKit is not configured', async () => {
    (ENV as any).LIVEKIT_URL = undefined;
    await expect(createCustomerCallToken('call-A', 'biz-1')).rejects.toThrow(/not configured/i);
  });

  it('starts with no active voice agents tracked', () => {
    // A fresh process (or a test file that never called startVoiceAgent)
    // must never report a phantom active agent.
    expect(activeVoiceAgentCount()).toBe(0);
  });
});
