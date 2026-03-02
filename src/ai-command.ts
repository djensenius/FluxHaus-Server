import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { AzureOpenAI } from 'openai';
import { FluxHausServices } from './services';

// ── Shared system prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = 'You are FluxHaus, an AI assistant for a smart home. '
  + 'You have tools to control the home. Execute the user\'s command using the '
  + 'available tools and reply with a concise, friendly confirmation.';

// ── Provider-agnostic tool definitions ───────────────────────────────────────

interface ToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: string[];
  };
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'lock_car',
    description: 'Lock the car doors',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'unlock_car',
    description: 'Unlock the car doors',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'start_car',
    description: 'Start the car climate control',
    parameters: {
      type: 'object',
      properties: {
        temperature: {
          type: 'number',
          description: 'Target temperature in Celsius (16–30)',
          minimum: 16,
          maximum: 30,
        },
        defrost: { type: 'boolean', description: 'Enable front windshield defrost' },
        heatedFeatures: { type: 'boolean', description: 'Enable heated steering wheel and mirrors' },
        seatFL: {
          type: 'number', description: 'Front-left seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
        seatFR: {
          type: 'number', description: 'Front-right seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
        seatRL: {
          type: 'number', description: 'Rear-left seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
        seatRR: {
          type: 'number', description: 'Rear-right seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
      },
    },
  },
  {
    name: 'stop_car',
    description: 'Stop the car climate control',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'resync_car',
    description: 'Force a status sync from the car',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'start_robot',
    description: 'Start a robot vacuum',
    parameters: {
      type: 'object',
      properties: {
        robot: {
          type: 'string',
          description: 'Which robot to start',
          enum: ['broombot', 'mopbot'],
        },
      },
      required: ['robot'],
    },
  },
  {
    name: 'stop_robot',
    description: 'Stop a robot vacuum and return it to base',
    parameters: {
      type: 'object',
      properties: {
        robot: {
          type: 'string',
          description: 'Which robot to stop',
          enum: ['broombot', 'mopbot'],
        },
      },
      required: ['robot'],
    },
  },
  {
    name: 'activate_scene',
    description: 'Activate a Home Assistant scene (lighting mood or blinds preset)',
    parameters: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Scene entity ID (e.g. scene.living_room_relax)' },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'list_scenes',
    description: 'List all available Home Assistant scenes',
    parameters: { type: 'object', properties: {} },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  services: FluxHausServices,
): Promise<string> {
  const {
    car, broombot, mopbot, homeAssistantClient,
  } = services;

  switch (name) {
  case 'lock_car':
    return car.lock();

  case 'unlock_car':
    return car.unlock();

  case 'start_car': {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: Record<string, any> = {};
    if (args.temperature !== undefined) config.temperature = args.temperature;
    if (args.defrost !== undefined) config.defrost = args.defrost;
    if (args.heatedFeatures !== undefined) config.heatedFeatures = args.heatedFeatures;
    if (
      args.seatFL !== undefined || args.seatFR !== undefined
        || args.seatRL !== undefined || args.seatRR !== undefined
    ) {
      config.seatClimateSettings = {
        driverSeat: args.seatFL ?? 0,
        passengerSeat: args.seatFR ?? 0,
        rearLeftSeat: args.seatRL ?? 0,
        rearRightSeat: args.seatRR ?? 0,
      };
    }
    const result = await car.start(config);
    setTimeout(() => { car.resync().catch(() => {}); }, 5000);
    return result;
  }

  case 'stop_car': {
    const result = await car.stop();
    setTimeout(() => { car.resync().catch(() => {}); }, 5000);
    return result;
  }

  case 'resync_car':
    await car.resync();
    return 'Car resync initiated';

  case 'start_robot':
    if (args.robot === 'broombot') {
      await broombot.turnOn();
    } else {
      await mopbot.turnOn();
    }
    return `${args.robot} started`;

  case 'stop_robot':
    if (args.robot === 'broombot') {
      await broombot.turnOff();
    } else {
      await mopbot.turnOff();
    }
    return `${args.robot} returning to base`;

  case 'activate_scene':
    await homeAssistantClient.callService('scene', 'turn_on', { entity_id: args.sceneId });
    return `Scene ${args.sceneId} activated`;

  case 'list_scenes': {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allStates: any[] = await homeAssistantClient.getState('');
    const scenes = Array.isArray(allStates)
      ? allStates
        .filter((s) => s.entity_id && s.entity_id.startsWith('scene.'))
        .map((s) => ({
          entityId: s.entity_id,
          name: s.attributes?.friendly_name ?? s.entity_id,
        }))
      : [];
    return JSON.stringify({ scenes }, null, 2);
  }

  default:
    return `Unknown tool: ${name}`;
  }
}

// ── Anthropic provider ────────────────────────────────────────────────────────

async function executeWithAnthropic(
  command: string,
  services: FluxHausServices,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const model = process.env.AI_MODEL || 'claude-3-5-sonnet-20241022';
  const client = new Anthropic({ apiKey });

  const tools: Anthropic.Tool[] = TOOL_DEFINITIONS.map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: def.parameters as Anthropic.Tool['input_schema'],
  }));

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: command },
  ];

  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock ? textBlock.text : 'Done.';
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      for (let j = 0; j < toolUseBlocks.length; j += 1) {
        const block = toolUseBlocks[j];
        if (block.type === 'tool_use') {
          // eslint-disable-next-line no-await-in-loop
          const result = await executeTool(
            block.name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            block.input as Record<string, any>,
            services,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    } else {
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock ? textBlock.text : 'Done.';
    }
  }

  return 'Command processed.';
}

// ── OpenAI-compatible provider ────────────────────────────────────────────────

async function executeWithOpenAICompatible(
  command: string,
  services: FluxHausServices,
  client: OpenAI,
  defaultModel: string,
): Promise<string> {
  const model = process.env.AI_MODEL || defaultModel;

  const tools: OpenAI.Chat.ChatCompletionTool[] = TOOL_DEFINITIONS.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  }));

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: command },
  ];

  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await client.chat.completions.create({
      model,
      tools,
      messages,
    });

    const choice = response.choices[0];

    if (choice.finish_reason === 'stop') {
      return choice.message.content ?? 'Done.';
    }

    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
      messages.push(choice.message);
      const fnCalls = choice.message.tool_calls.filter((tc) => tc.type === 'function');
      for (let j = 0; j < fnCalls.length; j += 1) {
        const toolCall = fnCalls[j];
        if (toolCall.type !== 'function') {
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await executeTool(
          toolCall.function.name,
          JSON.parse(toolCall.function.arguments || '{}'),
          services,
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    } else {
      return choice.message.content ?? 'Done.';
    }
  }

  return 'Command processed.';
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function executeAICommand(
  command: string,
  services: FluxHausServices,
): Promise<string> {
  const provider = (process.env.AI_PROVIDER || 'copilot').toLowerCase();

  switch (provider) {
  case 'anthropic':
    return executeWithAnthropic(command, services);

  case 'copilot':
  case 'github-copilot': {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not set for GitHub Copilot provider');
    return executeWithOpenAICompatible(
      command,
      services,
      new OpenAI({ baseURL: 'https://api.githubcopilot.com', apiKey: token }),
      'gpt-4o',
    );
  }

  case 'zai':
  case 'z.ai': {
    const apiKey = process.env.ZAI_API_KEY;
    if (!apiKey) throw new Error('ZAI_API_KEY is not set for Z.ai provider');
    const baseURL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/v1';
    return executeWithOpenAICompatible(
      command,
      services,
      new OpenAI({ baseURL, apiKey }),
      'glm-4-flash',
    );
  }

  case 'openai': {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set for OpenAI provider');
    return executeWithOpenAICompatible(
      command,
      services,
      new OpenAI({ apiKey }),
      'gpt-4o',
    );
  }

  case 'azure-openai': {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
    if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is not set for azure-openai provider');
    if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is not set for azure-openai provider');
    return executeWithOpenAICompatible(
      command,
      services,
      new AzureOpenAI({
        apiKey, endpoint, apiVersion,
      }),
      deployment,
    );
  }

  default:
    throw new Error(
      `Unknown AI_PROVIDER "${provider}". Supported values: anthropic, copilot, zai, openai, azure-openai`,
    );
  }
}
