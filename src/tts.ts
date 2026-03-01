import OpenAI from 'openai';
import logger from './logger';

// ── Text-to-Speech ────────────────────────────────────────────────────────────
//
// TTS_PROVIDER controls which backend is used:
//   openai  (default) — OpenAI TTS (tts-1 / tts-1-hd); natural, low-latency.
//                       Requires OPENAI_API_KEY.
//
// Provider comparison for TTS:
//   - OpenAI TTS       ★★★★★  Natural voices, low latency, MP3/OPUS/AAC/FLAC.
//   - ElevenLabs       ★★★★★  Most realistic, ideal for premium UX; higher cost.
//   - Google TTS       ★★★★☆  Good quality, WaveNet/Neural2 voices.
//   - Azure TTS        ★★★★☆  Wide language support, good for enterprise.
//   - Anthropic        ✗       No TTS offering.
//
// TTS_MODEL: tts-1 (default, lowest latency) | tts-1-hd (higher quality)
// TTS_VOICE: alloy (default) | ash | coral | echo | fable | onyx | nova | sage | shimmer

const ttsLogger = logger.child({ subsystem: 'tts' });

type OpenAITtsVoice = 'alloy' | 'ash' | 'coral' | 'echo' | 'fable' | 'onyx' | 'nova' | 'sage' | 'shimmer';

async function synthesizeWithOpenAI(text: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for TTS_PROVIDER=openai');

  const model = process.env.TTS_MODEL || 'tts-1';
  const voice = (process.env.TTS_VOICE || 'alloy') as OpenAITtsVoice;
  ttsLogger.debug({ model, voice }, 'Synthesizing speech via OpenAI TTS');

  const client = new OpenAI({ apiKey });
  const response = await client.audio.speech.create({
    model,
    voice,
    input: text,
    response_format: 'mp3',
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export default async function synthesizeSpeech(text: string): Promise<Buffer> {
  const provider = (process.env.TTS_PROVIDER || 'openai').toLowerCase();
  switch (provider) {
  case 'openai':
    return synthesizeWithOpenAI(text);
  default:
    throw new Error(
      `Unknown TTS_PROVIDER "${provider}". Supported values: openai`,
    );
  }
}
