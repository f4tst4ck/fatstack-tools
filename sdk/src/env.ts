import { z } from 'zod';

import { DEFAULT_FACILITATOR_URL } from './constants.js';

/**
 * Environment the paywall reads. Parsed lazily inside `paywall()`, never at module load,
 * so importing this package never throws in a build step.
 */
export const paywallEnvSchema = z.object({
  /** Hosted facilitator (Coinbase CDP). Fatstack does not run its own. */
  FACILITATOR_URL: z.string().url().default(DEFAULT_FACILITATOR_URL),
  FACILITATOR_API_KEY: z.string().min(1).optional(),
  /**
   * `1` takes every paywalled route offline with a 503. Intended for an incident where
   * continuing to take irreversible payments would be worse than being down.
   */
  KILLSWITCH: z.enum(['0', '1']).default('0'),
  /**
   * direct   = agent pays the provider wallet, 0% platform fee (the promotional window)
   * splitter = agent pays this provider's splitter contract, which forwards 98/2
   */
  FEE_MODE: z.enum(['direct', 'splitter']).default('direct'),
  /**
   * This provider's own splitter, required when FEE_MODE=splitter. One per provider:
   * the address is derivable from the factory, and quoting anyone else's would pay them.
   */
  SPLITTER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'SPLITTER_ADDRESS must be a 20-byte address')
    .optional(),
});

export type PaywallEnv = z.infer<typeof paywallEnvSchema>;

export function readPaywallEnv(
  source: Record<string, string | undefined> = process.env,
): PaywallEnv {
  return paywallEnvSchema.parse({
    FACILITATOR_URL: source.FACILITATOR_URL,
    FACILITATOR_API_KEY: source.FACILITATOR_API_KEY,
    KILLSWITCH: source.KILLSWITCH,
    FEE_MODE: source.FEE_MODE,
    SPLITTER_ADDRESS: source.SPLITTER_ADDRESS,
  });
}
