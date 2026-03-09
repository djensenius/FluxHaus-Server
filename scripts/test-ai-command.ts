#!/usr/bin/env npx ts-node
/**
 * Quick test for AI command execution with streaming progress.
 * Usage:
 *   npx ts-node scripts/test-ai-command.ts "What's the home status?"
 *   npx ts-node scripts/test-ai-command.ts --all   (runs a suite of test queries)
 *
 * Requires .env with: GITHUB_TOKEN (for copilot) or ANTHROPIC_API_KEY
 * Optional: AI_PROVIDER, AI_MODEL
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { executeAICommand } from '../src/ai-command';
import { FluxHausServices } from '../src/services';

const TEST_QUERIES = [
  "What's the car battery level?",
  'Lock the car',
  'What are the robots doing?',
  "What's the home status?",
  'Turn on the living room lights',
];

// Minimal services stub — tools will fail but we verify the AI attempts calls
const stubServices = {} as FluxHausServices;

async function runQuery(command: string): Promise<{
  command: string;
  toolsCalled: string[];
  finalText: string;
  elapsed: number;
  error?: string;
}> {
  const startTime = Date.now();
  const toolsCalled: string[] = [];

  try {
    const response = await executeAICommand(
      command,
      stubServices,
      [],
      (event) => {
        if (event.type === 'tool_call' && event.tool) {
          toolsCalled.push(event.tool);
        }
      },
    );

    return {
      command,
      toolsCalled,
      finalText: response.substring(0, 200),
      elapsed: (Date.now() - startTime) / 1000,
    };
  } catch (err) {
    return {
      command,
      toolsCalled,
      finalText: '',
      elapsed: (Date.now() - startTime) / 1000,
      error: err instanceof Error ? err.message.substring(0, 150) : String(err),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const runAll = args.includes('--all');
  const queries = runAll ? TEST_QUERIES : [args.join(' ') || TEST_QUERIES[0]];

  console.log(`\n🏠 AI Command Test`);
  console.log(`   Provider: ${process.env.AI_PROVIDER || 'copilot (default)'}`);
  console.log(`   Model:    ${process.env.AI_MODEL || '(default)'}\n`);

  for (const query of queries) {
    console.log(`━━━ "${query}" ━━━`);
    const result = await runQuery(query);

    if (result.toolsCalled.length > 0) {
      console.log(`  ✅ Tools called: ${result.toolsCalled.join(', ')}`);
    } else {
      console.log('  ⚠️  No tools called');
    }

    if (result.error) {
      console.log(`  💥 Error (expected w/ stubs): ${result.error.substring(0, 100)}`);
    } else {
      console.log(`  📋 Response: ${result.finalText.substring(0, 120)}`);
    }
    console.log(`  ⏱️  ${result.elapsed.toFixed(1)}s\n`);
  }
}

main();
