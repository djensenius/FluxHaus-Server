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
    name: 'list_entities',
    description: 'List Home Assistant entities, optionally filtered by domain (light, switch, scene, climate, etc.)',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain filter (e.g. light, switch, scene, climate). Omit to list all.' },
      },
    },
  },
  {
    name: 'get_entity_state',
    description: 'Get the current state and attributes of a Home Assistant entity',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID (e.g. light.bedroom, switch.porch)' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'call_ha_service',
    description: 'Call a Home Assistant service (e.g. turn on a light, toggle a switch, set climate temperature)',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Service domain (e.g. light, switch, climate, scene)' },
        service: { type: 'string', description: 'Service name (e.g. turn_on, turn_off, toggle)' },
        entity_id: { type: 'string', description: 'Target entity ID (e.g. light.bedroom)' },
        brightness_pct: { type: 'number', description: 'Brightness percentage (0-100), for lights only' },
        color_temp: { type: 'number', description: 'Color temperature in mireds, for lights only' },
        temperature: { type: 'number', description: 'Target temperature, for climate entities only' },
      },
      required: ['domain', 'service', 'entity_id'],
    },
  },
  {
    name: 'get_car_status',
    description: 'Get the car status: battery level, EV range, doors, locks, HVAC, trunk, hood, odometer',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_robot_status',
    description: 'Get the status of robot vacuums (Broombot and Mopbot): battery, running, charging, bin full',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_appliance_status',
    description: 'Get the status of home appliances: washer, dryer (Miele), and dishwasher (HomeConnect)',
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
    car, broombot, mopbot, homeAssistantClient, mieleClient, hc,
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

  case 'list_entities': {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allStates: any[] = await homeAssistantClient.getState('');
    let entities = Array.isArray(allStates) ? allStates : [];
    if (args.domain) {
      entities = entities.filter((s) => s.entity_id?.startsWith(`${args.domain}.`));
    }
    const result = entities.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      name: s.attributes?.friendly_name ?? s.entity_id,
    }));
    return JSON.stringify({ entities: result }, null, 2);
  }

  case 'get_entity_state': {
    const state = await homeAssistantClient.getState(args.entity_id);
    return JSON.stringify({
      entity_id: state.entity_id,
      state: state.state,
      attributes: state.attributes,
    }, null, 2);
  }

  case 'call_ha_service': {
    const {
      domain, service, entity_id: entityId, ...extraData
    } = args;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceData: Record<string, any> = { entity_id: entityId };
    for (const [key, value] of Object.entries(extraData)) {
      if (value !== undefined) serviceData[key] = value;
    }
    await homeAssistantClient.callService(domain, service, serviceData);
    return `Called ${domain}.${service} on ${entityId}`;
  }

  case 'get_car_status':
    return JSON.stringify({ status: car.status, odometer: car.odometer }, null, 2);

  case 'get_robot_status':
    return JSON.stringify({
      broombot: broombot.cachedStatus,
      mopbot: mopbot.cachedStatus,
    }, null, 2);

  case 'get_appliance_status':
    return JSON.stringify({
      washer: mieleClient.washer,
      dryer: mieleClient.dryer,
      dishwasher: hc.dishwasher,
    }, null, 2);

  default:
    return `Unknown tool: ${name}`;
  }
}

// ── Anthropic provider ────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function executeWithAnthropic(
  command: string,
  services: FluxHausServices,
  conversationHistory: ConversationMessage[] = [],
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
    ...conversationHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
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
  conversationHistory: ConversationMessage[] = [],
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
    ...conversationHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
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
  conversationHistory: ConversationMessage[] = [],
): Promise<string> {
  const provider = (process.env.AI_PROVIDER || 'copilot').toLowerCase();

  switch (provider) {
  case 'anthropic':
    return executeWithAnthropic(command, services, conversationHistory);

  case 'copilot':
  case 'github-copilot': {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not set for GitHub Copilot provider');
    return executeWithOpenAICompatible(
      command,
      services,
      new OpenAI({
        baseURL: 'https://api.githubcopilot.com',
        apiKey: token,
        defaultHeaders: { 'Copilot-Integration-Id': 'vscode-chat' },
      }),
      'gpt-4o',
      conversationHistory,
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
      conversationHistory,
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
      conversationHistory,
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
      conversationHistory,
    );
  }

  default:
    throw new Error(
      `Unknown AI_PROVIDER "${provider}". Supported values: anthropic, copilot, zai, openai, azure-openai`,
    );
  }
}
