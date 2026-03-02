import { Buffer } from 'node:buffer';

export function pcmToWav(pcmBuffer, {
  sampleRate = 48000,
  channels = 2,
  bitsPerSample = 16
} = {}) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM
  header.writeUInt16LE(1, 20); // audio format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  header.writeUInt32LE(byteRate, 28);
  const blockAlign = channels * (bitsPerSample / 8);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.from(pcmBuffer)]);
}
