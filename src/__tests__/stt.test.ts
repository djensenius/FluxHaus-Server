import OpenAI from 'openai';
import transcribeAudio from '../stt';

jest.mock('openai');

describe('transcribeAudio', () => {
  afterEach(() => {
    delete process.env.STT_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.STT_MODEL;
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;
    delete process.env.AZURE_SPEECH_LANGUAGE;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_STT_LANGUAGE;
    delete process.env.GOOGLE_STT_ENCODING;
    delete process.env.GOOGLE_STT_SAMPLE_RATE;
    jest.restoreAllMocks();
  });

  describe('OpenAI provider', () => {
    beforeEach(() => {
      process.env.STT_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test';
    });

    it('transcribes audio buffer and returns text', async () => {
      const mockCreate = jest.fn().mockResolvedValue({ text: 'Turn on the lights' });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        audio: { transcriptions: { create: mockCreate } },
      }));

      const result = await transcribeAudio(Buffer.from('fake audio'), 'audio.webm');
      expect(result).toBe('Turn on the lights');
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        model: 'whisper-1',
      }));
    });

    it('defaults filename to audio.webm', async () => {
      const mockCreate = jest.fn().mockResolvedValue({ text: 'hello' });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        audio: { transcriptions: { create: mockCreate } },
      }));

      await transcribeAudio(Buffer.from(''));
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.file.name).toBe('audio.webm');
    });

    it('uses STT_MODEL when set', async () => {
      process.env.STT_MODEL = 'whisper-large';
      const mockCreate = jest.fn().mockResolvedValue({ text: 'hello' });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        audio: { transcriptions: { create: mockCreate } },
      }));

      await transcribeAudio(Buffer.from(''), 'audio.mp3');
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'whisper-large' }));
    });

    it('throws when OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
        .rejects.toThrow('OPENAI_API_KEY');
    });
  });

  describe('Azure provider', () => {
    beforeEach(() => {
      process.env.STT_PROVIDER = 'azure';
      process.env.AZURE_SPEECH_KEY = 'azure-test-key';
      process.env.AZURE_SPEECH_REGION = 'eastus';
    });

    it('transcribes audio via Azure Speech REST API', async () => {
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ RecognitionStatus: 'Success', DisplayText: 'Turn on the lights' }),
      } as Response);

      const result = await transcribeAudio(Buffer.from('fake audio'), 'audio.webm');
      expect(result).toBe('Turn on the lights');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('eastus.stt.speech.microsoft.com'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'azure-test-key' }),
        }),
      );
    });

    it('uses AZURE_SPEECH_LANGUAGE when set', async () => {
      process.env.AZURE_SPEECH_LANGUAGE = 'fr-FR';
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ RecognitionStatus: 'Success', DisplayText: 'Bonjour' }),
      } as Response);

      const result = await transcribeAudio(Buffer.from(''), 'audio.webm');
      expect(result).toBe('Bonjour');
    });

    it('throws when AZURE_SPEECH_KEY is not set', async () => {
      delete process.env.AZURE_SPEECH_KEY;
      await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
        .rejects.toThrow('AZURE_SPEECH_KEY');
    });

    it('throws when AZURE_SPEECH_REGION is not set', async () => {
      delete process.env.AZURE_SPEECH_REGION;
      await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
        .rejects.toThrow('AZURE_SPEECH_REGION');
    });

    it('throws on non-ok HTTP response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as Response);

      await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
        .rejects.toThrow('401');
    });

    it('throws when RecognitionStatus is not Success', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ RecognitionStatus: 'NoMatch' }),
      } as Response);

      await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
        .rejects.toThrow('NoMatch');
    });
  });

  describe('Google provider', () => {
    beforeEach(() => {
      process.env.STT_PROVIDER = 'google';
      process.env.GOOGLE_API_KEY = 'google-test-key';
    });

    it('transcribes audio via Google Speech-to-Text REST API', async () => {
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ alternatives: [{ transcript: 'Turn on the lights' }] }],
        }),
      } as Response);

      const result = await transcribeAudio(Buffer.from('fake audio'), 'audio.webm');
      expect(result).toBe('Turn on the lights');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('speech.googleapis.com'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns empty string when results are empty', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response);

      const result = await transcribeAudio(Buffer.from(''), 'audio.webm');
      expect(result).toBe('');
    });

    it('uses GOOGLE_STT_LANGUAGE when set', async () => {
      process.env.GOOGLE_STT_LANGUAGE = 'de-DE';
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ alternatives: [{ transcript: 'Hallo' }] }] }),
      } as Response);

      await transcribeAudio(Buffer.from(''), 'audio.webm');
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.config.languageCode).toBe('de-DE');
    });

    it('throws when GOOGLE_API_KEY is not set', async () => {
      delete process.env.GOOGLE_API_KEY;
      await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
        .rejects.toThrow('GOOGLE_API_KEY');
    });

    it('throws on non-ok HTTP response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      } as Response);

      await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
        .rejects.toThrow('403');
    });
  });

  it('defaults to openai provider when STT_PROVIDER is unset', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mockCreate = jest.fn().mockResolvedValue({ text: 'hello' });
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      audio: { transcriptions: { create: mockCreate } },
    }));

    const result = await transcribeAudio(Buffer.from(''));
    expect(result).toBe('hello');
  });

  it('throws for unknown STT_PROVIDER', async () => {
    process.env.STT_PROVIDER = 'unknown-provider';
    await expect(transcribeAudio(Buffer.from(''), 'audio.webm'))
      .rejects.toThrow('Unknown STT_PROVIDER');
  });
});
