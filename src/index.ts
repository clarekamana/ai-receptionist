import app from './app';
import { ENV } from './config/env';
import dotenv from 'dotenv';
import { dispose as disposeLiveKitFfi } from '@livekit/rtc-node';
import { startSessionMaintenanceSweep } from './services/callSessionService';
import { startOutboxRetryLoop } from './services/callLogPersistenceService';
import { startAppCallMaintenanceSweep } from './calls/call.service';
dotenv.config();

app.listen(4000, '0.0.0.0', () => {
  console.log(`AI Receptionist Backend running on port ${ENV.PORT}`);
});

// Started only when the server actually boots (not when test files import
// individual modules directly) so unit tests never spin up background
// intervals of their own.
startSessionMaintenanceSweep();
startOutboxRetryLoop();
startAppCallMaintenanceSweep();

// @livekit/rtc-node runs a shared native FFI server process underneath
// every Room/agent this backend creates — per its own docs, that process
// must be explicitly disposed on shutdown or it can be left running.
// Harmless to call even if no voice agent ever actually ran (e.g. LiveKit
// was never configured).
async function shutdown(signal: string) {
  console.log(`[server] Received ${signal}, shutting down.`);
  try {
    await disposeLiveKitFfi();
  } catch (error) {
    console.error('[server] Error disposing LiveKit FFI client.', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));