import OpenAI from 'openai';
import synthesizeSpeech from '../tts';

jest.mock('openai');

describe('synthesizeSpeech', () => {
  afterEach(() => {
    delete process.env.TTS_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TTS_MODEL;
    delete process.env.TTS_VOICE;
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
