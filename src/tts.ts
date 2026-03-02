import OpenAI from 'openai';
import logger from './logger';

// ── Text-to-Speech ────────────────────────────────────────────────────────────
//
// TTS_PROVIDER controls which backend is used:
//   openai      (default) — OpenAI TTS (tts-1 / tts-1-hd); natural, low-latency.
//                           Requires OPENAI_API_KEY.
//   azure               — Azure Cognitive Services Speech REST API.
//                           Requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.
//                           Optional: AZURE_TTS_VOICE (default: en-US-JennyNeural).
//   google              — Google Cloud Text-to-Speech REST API.
//                           Requires GOOGLE_API_KEY.
//                           Optional: GOOGLE_TTS_VOICE (default: en-US-Neural2-F).
//   elevenlabs          — ElevenLabs Text-to-Speech REST API; most realistic voices.
//                           Requires ELEVENLABS_API_KEY.
//                           Optional: ELEVENLABS_VOICE_ID (default: Rachel),
//                                     ELEVENLABS_MODEL (default: eleven_monolingual_v1).
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

async function synthesizeWithAzure(text: string): Promise<Buffer> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key) throw new Error('AZURE_SPEECH_KEY is required for TTS_PROVIDER=azure');
  if (!region) throw new Error('AZURE_SPEECH_REGION is required for TTS_PROVIDER=azure');

  const voice = process.env.AZURE_TTS_VOICE || 'en-US-JennyNeural';
  // Azure voice names follow the pattern '{lang}-{region}-{Name}Neural', e.g. 'en-US-JennyNeural'.
  // The first two dash-delimited segments form the BCP-47 language code for the SSML.
  const langCode = voice.split('-').slice(0, 2).join('-');
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  const ssml = [
    `<speak version='1.0' xml:lang='${langCode}'>`,
    `<voice xml:lang='${langCode}' name='${voice}'>${escapedText}</voice>`,
    '</speak>',
  ].join('');
  ttsLogger.debug({ region, voice }, 'Synthesizing speech via Azure TTS');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
    },
    body: ssml,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azure TTS request failed (${response.status}): ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function synthesizeWithGoogle(text: string): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is required for TTS_PROVIDER=google');

  const voice = process.env.GOOGLE_TTS_VOICE || 'en-US-Neural2-F';
  // Google voice names follow the pattern '{lang}-{region}-{Type}-{Variant}', e.g. 'en-US-Neural2-F'.
  // The first two dash-delimited segments form the BCP-47 language code required by the API.
  const languageCode = voice.split('-').slice(0, 2).join('-');
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;
  ttsLogger.debug({ voice }, 'Synthesizing speech via Google TTS');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voice },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google TTS request failed (${response.status}): ${errText}`);
  }

  const data = await response.json() as { audioContent: string };
  return Buffer.from(data.audioContent, 'base64');
}

async function synthesizeWithElevenLabs(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required for TTS_PROVIDER=elevenlabs');

  // Default: Rachel voice (ElevenLabs built-in)
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const modelId = process.env.ELEVENLABS_MODEL || 'eleven_monolingual_v1';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  ttsLogger.debug({ voiceId, modelId }, 'Synthesizing speech via ElevenLabs TTS');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text, model_id: modelId }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS request failed (${response.status}): ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export default async function synthesizeSpeech(text: string): Promise<Buffer> {
  const provider = (process.env.TTS_PROVIDER || 'openai').toLowerCase();
  switch (provider) {
  case 'openai':
    return synthesizeWithOpenAI(text);
  case 'azure':
    return synthesizeWithAzure(text);
  case 'google':
    return synthesizeWithGoogle(text);
  case 'elevenlabs':
    return synthesizeWithElevenLabs(text);
  default:
    throw new Error(
      `Unknown TTS_PROVIDER "${provider}". Supported values: openai, azure, google, elevenlabs`,
    );
  }
}
