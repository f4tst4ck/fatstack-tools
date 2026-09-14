import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The example published in the AI SDK tools registry.
 *
 * Whether it *compiles* is settled by `pnpm typecheck`: `example/` is in the tsconfig, so a
 * renamed option or a dropped `guards` fails the build. That covers the API.
 *
 * What a compiler cannot object to is an example that works perfectly and spends real money
 * the first time someone pastes it. These are the properties that are correct TypeScript
 * and still wrong.
 */
const EXAMPLE = readFileSync(new URL('../example/ai-sdk-registry.ts', import.meta.url), 'utf8');

describe('the published example is safe to paste', () => {
  it('pays on a testnet', () => {
    expect(EXAMPLE).toMatch(/networks:\s*\['base-sepolia'\]/);
  });

  it('never names mainnet', () => {
    // `['base']` would type-check and would spend real USDC on a first run.
    expect(EXAMPLE).not.toMatch(/networks:\s*\[[^\]]*'base'/);
  });

  it('caps the day, not only the call', () => {
    // maxPerCall alone bounds one call and nothing else: a loop can still drain the wallet.
    expect(EXAMPLE).toMatch(/maxPerDay:\s*[\d.]+/);
  });

  it('keeps the ceiling small enough to be a demonstration', () => {
    const daily = Number(/maxPerDay:\s*([\d.]+)/.exec(EXAMPLE)?.[1]);
    expect(daily).toBeGreaterThan(0);
    expect(daily).toBeLessThanOrEqual(1);
  });

  it('reads the key from the environment rather than embedding one', () => {
    expect(EXAMPLE).toContain('process.env.AGENT_PRIVATE_KEY');
    expect(EXAMPLE).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
