/**
 * Runnable end-to-end example on Base Sepolia: discover a tool, pay for it, use the result.
 *
 * Real testnet USDC moves. Nothing is simulated — the part worth showing is that the
 * payment settles, not that the types line up.
 *
 * **Why this stands up its own tool.** The public Fatstack catalogue serves Base *mainnet*
 * listings only, so there is nothing on Sepolia to discover. Rather than have the example
 * spend real money, or quietly not run, it serves one paywalled tool on a local port and a
 * one-listing registry describing it. Everything after that — discovery, the 402, the
 * signature, settlement — is the identical code path a mainnet agent takes.
 *
 *   AGENT_PRIVATE_KEY=0x... pnpm example
 */
import { serve } from '@hono/node-server';
import { paywall } from '@fatstack/x402';
import { honoPaywall } from '@fatstack/x402/hono';
import { Hono } from 'hono';
import { privateKeyToAccount } from 'viem/accounts';

import { fatstackTools } from '../src/index.js';

const KEY = process.env.AGENT_PRIVATE_KEY;
// The burn address by default, deliberately. An earlier version of this example paid a
// wallet that a monitoring job watched to decide a scheduled security suite was still
// running — so anyone following the README would have reset that alarm and left a dead
// suite looking alive. An example anyone can run must never be able to satisfy a monitor.
// Override with EXAMPLE_PAYEE to send testnet USDC somewhere you control.
const PROVIDER_WALLET = process.env.EXAMPLE_PAYEE ?? '0x000000000000000000000000000000000000dEaD';
const PRICE = '0.001';
const REGISTRY_URL = 'https://registry.example/registry.json';

async function main(): Promise<void> {
  if (!KEY) {
    console.error(
      'Set AGENT_PRIVATE_KEY to a Base Sepolia wallet holding testnet USDC.\n' +
        'It needs USDC and no ETH: x402 payments are signed off-chain and the facilitator\n' +
        'pays the gas, so the payer never sends a transaction. See README.md.',
    );
    process.exit(1);
  }
  const wallet = privateKeyToAccount(KEY as `0x${string}`);
  console.log(`payer ${wallet.address} on Base Sepolia`);

  // 1. A paywalled tool, using the same middleware a real provider runs.
  const app = new Hono();
  app.use(
    '*',
    honoPaywall(
      paywall({
        price: PRICE,
        wallet: PROVIDER_WALLET,
        toolId: 'example-unit-convert',
        network: 'base-sepolia',
      }),
    ),
  );
  app.all('*', (c) => c.json({ celsius: 20, fahrenheit: 68 }));
  const server = serve({ fetch: (r: Request) => app.fetch(r), port: 0 });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const toolUrl = `http://localhost:${port}/convert`;

  // 2. A registry describing it, in the shape the public catalogue uses.
  /*
   * Serves the catalogue and nothing else.
   *
   * The URL check matters: an earlier version answered every request, so the *payment*
   * also hit this stub and the example printed the registry back as if it were the tool's
   * answer — reporting success while settling nothing. Anything that is not the registry
   * goes to the real network.
   */
  const registry = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(REGISTRY_URL)) return globalThis.fetch(input as never, init);
    return Response.json({
      tools: [
        {
          slug: 'example-unit-convert',
          name: 'Unit convert',
          description: 'Converts 20C to Fahrenheit. Send {} as input.',
          url: toolUrl,
          payment: {
            scheme: 'exact',
            network: 'eip155:84532',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: PROVIDER_WALLET,
            amountUsd: '0.001000',
          },
        },
      ],
    });
  }) as typeof globalThis.fetch;

  try {
    // 3. Discovery — free, and it pays for nothing.
    const tools = await fatstackTools({
      wallet,
      networks: ['base-sepolia'],
      network: 'eip155:84532',
      guards: { maxPerDay: 0.05, maxPerCall: 0.01 }, // required; omit it and this throws
      registryUrl: REGISTRY_URL,
      fetch: registry,
    });

    const names = Object.keys(tools);
    console.log(`discovered ${names.length} payable tool(s): ${names.join(', ')}`);

    // 4. Call it. This signs an EIP-3009 authorisation and settles on Base Sepolia.
    const chosen = tools[names[0]!] as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    console.log(`calling ${names[0]} — spends $${PRICE} of testnet USDC`);

    const started = Date.now();
    const result = await chosen.execute({ input: {} }, { toolCallId: 'example', messages: [] });
    console.log(`settled in ${Date.now() - started}ms`);
    console.log('result:', JSON.stringify(result));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main();
