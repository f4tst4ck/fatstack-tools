import { payFetch } from '@fatstack/x402';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { requireGuards, type SpendGuards } from './guards.js';
import {
  fetchListings,
  toolNameFor,
  type FatstackListing,
  type FetchListingsOptions,
} from './registry.js';

export { MissingSpendGuardError, guardsSchema, type SpendGuards } from './guards.js';
export { DEFAULT_REGISTRY_URL, fetchListings, toolNameFor } from './registry.js';
export type { FatstackListing } from './registry.js';

/** A viem-compatible account that can sign an EIP-3009 authorisation. */
export type Wallet = Parameters<typeof payFetch>[2]['wallet'];

export interface FatstackToolsOptions extends FetchListingsOptions {
  /** The wallet that pays. Its USDC is what gets spent. */
  wallet: Wallet;
  /**
   * Spend caps. **Required** — see `guards.ts` for why there is no default.
   */
  guards: SpendGuards;
  /** Which chain to pay on. Defaults to Base mainnet. */
  networks?: ('base' | 'base-sepolia')[];
}

/**
 * Turns the Fatstack catalogue into AI SDK tools that pay for themselves.
 *
 * Discovery is free and happens once, here. Each returned tool wraps one listing; calling
 * it issues an x402 payment from your wallet and returns the response. The agent never
 * sees a key and cannot raise its own limit — the caps are closed over at construction.
 *
 * ```ts
 * const tools = await fatstackTools({
 *   wallet: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY),
 *   guards: { maxPerDay: 1.0, maxPerCall: 0.01 },
 * });
 * const result = await generateText({ model, tools, prompt: 'Convert 20C to F' });
 * ```
 */
export async function fatstackTools(options: FatstackToolsOptions) {
  // Before the network is touched: a missing cap should fail on the line that forgot it,
  // not after a catalogue fetch that makes it look like a connectivity problem.
  const guards = requireGuards(options.guards);
  const networks = options.networks ?? ['base'];

  const listings = await fetchListings(options);
  return buildTools(listings, { ...options, guards, networks });
}

/** The tool-building half, separated so it can be tested without a network. */
export function buildTools(
  listings: FatstackListing[],
  options: Omit<FatstackToolsOptions, 'guards'> & {
    guards: SpendGuards;
    networks: ('base' | 'base-sepolia')[];
    fetch?: typeof globalThis.fetch;
  },
) {
  const guards = requireGuards(options.guards);
  // `ToolSet` is the AI SDK's own type for a collection of tools, so what we return is
  // exactly what `generateText({ tools })` expects rather than a lookalike.
  const tools: ToolSet = {};

  for (const listing of listings) {
    tools[toolNameFor(listing)] = tool({
      description:
        `${listing.description} Costs $${listing.payment.amountUsd} USDC per call, ` +
        'paid from your wallet. Payments are final and there are no refunds.',
      // Deliberately loose: the catalogue does not publish per-tool argument schemas, and
      // inventing one per listing would make the model send arguments the tool never
      // accepts. The listing's own description tells the model what to put here.
      inputSchema: z.object({
        input: z
          .record(z.unknown())
          .describe('Arguments for the tool, as described in its description.'),
      }),
      execute: async ({ input }) => {
        const response = await payFetch(
          listing.url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input ?? {}),
          },
          {
            wallet: options.wallet,
            networks: options.networks,
            guards,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          },
        );

        const text = await response.text();
        if (!response.ok) {
          // Returned rather than thrown: the model can often recover by trying a different
          // tool, and an exception here ends the whole generation.
          return { ok: false, status: response.status, error: text.slice(0, 500) };
        }
        try {
          // Annotated, not cast: a tool's response has no schema we could parse it
          // against — it is whatever the provider returns — so it stays `unknown` and the
          // model reads it as data.
          const parsed: unknown = JSON.parse(text);
          return { ok: true, result: parsed };
        } catch {
          return { ok: true, result: text };
        }
      },
    });
  }

  return tools;
}
