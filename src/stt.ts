import OpenAI from 'openai';
import logger from './logger';

// ── Speech-to-Text ────────────────────────────────────────────────────────────
//
// STT_PROVIDER controls which backend is used:
//   openai  (default) — OpenAI Whisper; best-in-class accuracy, multilingual.
//                       Requires OPENAI_API_KEY.
//
// Provider comparison for STT:
//   - OpenAI Whisper   ★★★★★  Best accuracy & language coverage.
//   - Azure Speech     ★★★★☆  Good for enterprise / on-prem needs.
//   - Google STT       ★★★★☆  Strong, but higher cost at scale.
//   - Anthropic        ✗       No STT offering.

const sttLogger = logger.child({ subsystem: 'stt' });

const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  m4a: 'audio/m4a',
  ogg: 'audio/ogg',
  mpga: 'audio/mpeg',
};

function mimeTypeForFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'audio/webm';
}

async function transcribeWithOpenAI(audioBuffer: Buffer, filename: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for STT_PROVIDER=openai');

  const model = process.env.STT_MODEL || 'whisper-1';
  sttLogger.debug({ model, filename }, 'Transcribing audio via OpenAI Whisper');

  const client = new OpenAI({ apiKey });
  const file = new File([new Uint8Array(audioBuffer)], filename, { type: mimeTypeForFilename(filename) });
  const transcription = await client.audio.transcriptions.create({ file, model });
  return transcription.text;
}

export default async function transcribeAudio(audioBuffer: Buffer, filename = 'audio.webm'): Promise<string> {
  const provider = (process.env.STT_PROVIDER || 'openai').toLowerCase();
  switch (provider) {
  case 'openai':
    return transcribeWithOpenAI(audioBuffer, filename);
  default:
    throw new Error(
      `Unknown STT_PROVIDER "${provider}". Supported values: openai`,
    );
  }
}
