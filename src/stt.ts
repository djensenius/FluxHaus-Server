import OpenAI from 'openai';
import logger from './logger';

// ── Speech-to-Text ────────────────────────────────────────────────────────────
//
// STT_PROVIDER controls which backend is used:
//   openai  (default) — OpenAI Whisper; best-in-class accuracy, multilingual.
//                       Requires OPENAI_API_KEY.
//   azure             — Azure Cognitive Services Speech REST API.
//                       Requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.
//                       Optional: AZURE_SPEECH_LANGUAGE (default: en-US).
//   google            — Google Cloud Speech-to-Text REST API.
//                       Requires GOOGLE_API_KEY.
//                       Optional: GOOGLE_STT_LANGUAGE (default: en-US),
//                                 GOOGLE_STT_ENCODING (default: auto from filename),
//                                 GOOGLE_STT_SAMPLE_RATE (default: 16000).
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

// Maps file extension to Google Speech-to-Text encoding type.
// Falls back to WEBM_OPUS (matches the default 'audio.webm' filename).
const GOOGLE_STT_ENCODINGS: Record<string, string> = {
  mp3: 'MP3',
  wav: 'LINEAR16',
  flac: 'FLAC',
  ogg: 'OGG_OPUS',
  webm: 'WEBM_OPUS',
};

function mimeTypeForFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'audio/webm';
}

function googleEncodingForFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return GOOGLE_STT_ENCODINGS[ext] ?? 'WEBM_OPUS';
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

async function transcribeWithAzure(audioBuffer: Buffer, filename: string): Promise<string> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key) throw new Error('AZURE_SPEECH_KEY is required for STT_PROVIDER=azure');
  if (!region) throw new Error('AZURE_SPEECH_REGION is required for STT_PROVIDER=azure');

  const language = process.env.AZURE_SPEECH_LANGUAGE || 'en-US';
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${language}&format=detailed`;
  sttLogger.debug({ region, language, filename }, 'Transcribing audio via Azure Speech');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': mimeTypeForFilename(filename),
    },
    body: new Uint8Array(audioBuffer),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure Speech STT request failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { RecognitionStatus: string; DisplayText?: string };
  if (data.RecognitionStatus !== 'Success') {
    throw new Error(`Azure Speech STT recognition failed: ${data.RecognitionStatus}`);
  }
  return data.DisplayText ?? '';
}

async function transcribeWithGoogle(audioBuffer: Buffer, filename: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is required for STT_PROVIDER=google');

  const language = process.env.GOOGLE_STT_LANGUAGE || 'en-US';
  const encoding = process.env.GOOGLE_STT_ENCODING || googleEncodingForFilename(filename);
  const sampleRateHertz = Number(process.env.GOOGLE_STT_SAMPLE_RATE || '16000');
  const url = `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`;
  sttLogger.debug({ language, encoding, filename }, 'Transcribing audio via Google Speech-to-Text');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { encoding, sampleRateHertz, languageCode: language },
      audio: { content: audioBuffer.toString('base64') },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Speech-to-Text request failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
  };
  return data.results?.[0]?.alternatives?.[0]?.transcript ?? '';
}

export default async function transcribeAudio(audioBuffer: Buffer, filename = 'audio.webm'): Promise<string> {
  const provider = (process.env.STT_PROVIDER || 'openai').toLowerCase();
  switch (provider) {
  case 'openai':
    return transcribeWithOpenAI(audioBuffer, filename);
  case 'azure':
    return transcribeWithAzure(audioBuffer, filename);
  case 'google':
    return transcribeWithGoogle(audioBuffer, filename);
  default:
    throw new Error(
      `Unknown STT_PROVIDER "${provider}". Supported values: openai, azure, google`,
    );
  }
}
