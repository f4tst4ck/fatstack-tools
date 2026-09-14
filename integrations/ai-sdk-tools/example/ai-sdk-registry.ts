/**
 * The example published in the AI SDK tools registry.
 *
 * This file is the source of that snippet, character for character, and it exists as real
 * code rather than a string so the compiler has an opinion about it. The registry entry at
 * https://ai-sdk.dev/resources/tools is read and pasted by people starting from zero; an
 * example that no longer matches the package teaches them an API that does not exist.
 *
 * A reviewer on vercel/ai#20711 asked for a test that "the metadata and example work as
 * expected, especially the required guards config". Asserting that the snippet *contains*
 * the word `guards` would have checked its spelling. Compiling it checks it: if `guards`
 * stopped being required, if an option were renamed, or if the example simply did not
 * build, `pnpm typecheck` fails here.
 *
 * It is never executed — calling it would spend USDC — so `AGENT_PRIVATE_KEY` need not be
 * set for the check to mean something.
 */
import { generateText, isStepCount } from 'ai';
import { fatstackTools } from '@fatstack/ai-sdk-tools';
import { privateKeyToAccount } from 'viem/accounts';

// Discovery is free and happens once; only calling a tool costs anything.
// `guards` is required — omit it and construction fails before the catalogue is fetched.
const tools = await fatstackTools({
  wallet: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  networks: ['base-sepolia'],
  guards: { maxPerDay: 0.5, maxPerCall: 0.01 },
});

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  prompt: 'Convert 20 degrees Celsius to Fahrenheit.',
  tools,
  stopWhen: isStepCount(3),
});

console.log(text);
