import OpenAI from 'openai';
import synthesizeSpeech from '../tts';

jest.mock('openai');

describe('synthesizeSpeech', () => {
  afterEach(() => {
    delete process.env.TTS_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TTS_MODEL;
    delete process.env.TTS_VOICE;
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;
    delete process.env.AZURE_TTS_VOICE;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_TTS_VOICE;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    delete process.env.ELEVENLABS_MODEL;
    jest.restoreAllMocks();
  });

  describe('OpenAI provider', () => {
    beforeEach(() => {
      process.env.TTS_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test';
    });

    it('synthesizes speech and returns a Buffer', async () => {
      const fakeArrayBuffer = new ArrayBuffer(8);
      const mockCreate = jest.fn().mockResolvedValue({
        arrayBuffer: jest.fn().mockResolvedValue(fakeArrayBuffer),
      });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        audio: { speech: { create: mockCreate } },
      }));

      const result = await synthesizeSpeech('Hello world');
      expect(result).toBeInstanceOf(Buffer);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        model: 'tts-1',
        voice: 'alloy',
        input: 'Hello world',
        response_format: 'mp3',
      }));
    });

    it('uses TTS_MODEL and TTS_VOICE when set', async () => {
      process.env.TTS_MODEL = 'tts-1-hd';
      process.env.TTS_VOICE = 'nova';
      const mockCreate = jest.fn().mockResolvedValue({
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
      });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        audio: { speech: { create: mockCreate } },
      }));

      await synthesizeSpeech('Test');
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        model: 'tts-1-hd',
        voice: 'nova',
      }));
    });

    it('throws when OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(synthesizeSpeech('hello'))
        .rejects.toThrow('OPENAI_API_KEY');
    });
  });

  describe('Azure provider', () => {
    beforeEach(() => {
      process.env.TTS_PROVIDER = 'azure';
      process.env.AZURE_SPEECH_KEY = 'azure-test-key';
      process.env.AZURE_SPEECH_REGION = 'eastus';
    });

    it('synthesizes speech via Azure TTS REST API and returns a Buffer', async () => {
      const fakeAudioData = new ArrayBuffer(16);
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => fakeAudioData,
      } as Response);

      const result = await synthesizeSpeech('Hello world');
      expect(result).toBeInstanceOf(Buffer);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('eastus.tts.speech.microsoft.com'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'azure-test-key' }),
        }),
      );
    });

    it('includes SSML with escaped text in request body', async () => {
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as Response);

      await synthesizeSpeech('Say <hello> & "goodbye"');
      const body = (mockFetch.mock.calls[0][1] as RequestInit).body as string;
      expect(body).toContain('&lt;hello&gt;');
      expect(body).toContain('&amp;');
    });

    it('uses AZURE_TTS_VOICE when set', async () => {
      process.env.AZURE_TTS_VOICE = 'en-GB-RyanNeural';
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as Response);

      await synthesizeSpeech('Hello');
      const body = (mockFetch.mock.calls[0][1] as RequestInit).body as string;
      expect(body).toContain('en-GB-RyanNeural');
    });

    it('throws when AZURE_SPEECH_KEY is not set', async () => {
      delete process.env.AZURE_SPEECH_KEY;
      await expect(synthesizeSpeech('hello')).rejects.toThrow('AZURE_SPEECH_KEY');
    });

    it('throws when AZURE_SPEECH_REGION is not set', async () => {
      delete process.env.AZURE_SPEECH_REGION;
      await expect(synthesizeSpeech('hello')).rejects.toThrow('AZURE_SPEECH_REGION');
    });

    it('throws on non-ok HTTP response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as Response);

      await expect(synthesizeSpeech('hello')).rejects.toThrow('401');
    });
  });

  describe('Google provider', () => {
    beforeEach(() => {
      process.env.TTS_PROVIDER = 'google';
      process.env.GOOGLE_API_KEY = 'google-test-key';
    });

    it('synthesizes speech via Google TTS REST API and returns a Buffer', async () => {
      const fakeBase64 = Buffer.from('fake audio').toString('base64');
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: fakeBase64 }),
      } as Response);

      const result = await synthesizeSpeech('Hello world');
      expect(result).toBeInstanceOf(Buffer);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('texttospeech.googleapis.com'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('uses GOOGLE_TTS_VOICE when set', async () => {
      process.env.GOOGLE_TTS_VOICE = 'en-US-Wavenet-D';
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: '' }),
      } as Response);

      await synthesizeSpeech('Hello');
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.voice.name).toBe('en-US-Wavenet-D');
      expect(body.voice.languageCode).toBe('en-US');
    });

    it('throws when GOOGLE_API_KEY is not set', async () => {
      delete process.env.GOOGLE_API_KEY;
      await expect(synthesizeSpeech('hello')).rejects.toThrow('GOOGLE_API_KEY');
    });

    it('throws on non-ok HTTP response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      } as Response);

      await expect(synthesizeSpeech('hello')).rejects.toThrow('403');
    });
  });

  describe('ElevenLabs provider', () => {
    beforeEach(() => {
      process.env.TTS_PROVIDER = 'elevenlabs';
      process.env.ELEVENLABS_API_KEY = 'el-test-key';
    });

    it('synthesizes speech via ElevenLabs REST API and returns a Buffer', async () => {
      const fakeAudioData = new ArrayBuffer(16);
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => fakeAudioData,
      } as Response);

      const result = await synthesizeSpeech('Hello world');
      expect(result).toBeInstanceOf(Buffer);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.elevenlabs.io/v1/text-to-speech'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'xi-api-key': 'el-test-key' }),
        }),
      );
    });

    it('uses ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL when set', async () => {
      process.env.ELEVENLABS_VOICE_ID = 'custom-voice-id';
      process.env.ELEVENLABS_MODEL = 'eleven_multilingual_v2';
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as Response);

      await synthesizeSpeech('Hello');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('custom-voice-id'),
        expect.objectContaining({
          body: JSON.stringify({ text: 'Hello', model_id: 'eleven_multilingual_v2' }),
        }),
      );
    });

    it('throws when ELEVENLABS_API_KEY is not set', async () => {
      delete process.env.ELEVENLABS_API_KEY;
      await expect(synthesizeSpeech('hello')).rejects.toThrow('ELEVENLABS_API_KEY');
    });

    it('throws on non-ok HTTP response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      } as Response);

      await expect(synthesizeSpeech('hello')).rejects.toThrow('429');
    });
  });

  it('defaults to openai provider when TTS_PROVIDER is unset', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mockCreate = jest.fn().mockResolvedValue({
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
    });
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      audio: { speech: { create: mockCreate } },
    }));

    const result = await synthesizeSpeech('test');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('throws for unknown TTS_PROVIDER', async () => {
    process.env.TTS_PROVIDER = 'unknown-provider';
    await expect(synthesizeSpeech('hello'))
      .rejects.toThrow('Unknown TTS_PROVIDER');
  });
});
