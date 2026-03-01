import OpenAI from 'openai';
import transcribeAudio from '../stt';

jest.mock('openai');

describe('transcribeAudio', () => {
  afterEach(() => {
    delete process.env.STT_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.STT_MODEL;
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
