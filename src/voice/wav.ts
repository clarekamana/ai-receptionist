/**
 * Minimal PCM16 WAV encode/decode — just enough to (a) hand Groq's
 * transcription endpoint a real audio file instead of headerless PCM, and
 * (b) read whatever sample rate/channel count Groq's TTS actually returns
 * so it can be resampled correctly rather than assumed. No dependency:
 * WAV's PCM container is a handful of fixed-size header fields.
 */

export interface DecodedWav {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

/** Throws if `buffer` isn't a canonical 16-bit PCM WAV file — callers
 * (voice.pipeline's TTS step) must treat that as a TTS-provider failure,
 * not silently play garbage audio. */
export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file.');
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkBodyStart = offset + 8;

    if (chunkId === 'fmt ') {
      channels = buffer.readUInt16LE(chunkBodyStart + 2);
      sampleRate = buffer.readUInt32LE(chunkBodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkBodyStart + 14);
    } else if (chunkId === 'data') {
      dataStart = chunkBodyStart;
      dataLength = chunkSize;
    }

    // Chunks are word-aligned; odd-sized chunks have a padding byte.
    offset = chunkBodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataStart === -1 || bitsPerSample !== 16 || sampleRate === 0 || channels === 0) {
    throw new Error('Unsupported WAV format (expected 16-bit PCM with fmt/data chunks).');
  }

  const clampedLength = Math.min(dataLength, buffer.length - dataStart);
  const samples = new Int16Array(clampedLength / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buffer.readInt16LE(dataStart + i * 2);
  }

  return { samples, sampleRate, channels };
}

/** Wraps raw PCM16 mono samples in a minimal canonical WAV header — what
 * Groq's transcription endpoint (and any standard audio tool) expects. */
export function encodeWavMono16(samples: Int16Array, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format: PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}
