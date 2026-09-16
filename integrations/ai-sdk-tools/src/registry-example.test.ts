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
  it('names a network the public catalogue actually serves', () => {
    // This assertion was inverted. It used to require `base-sepolia`, on the reasoning that a
    // copy-paste should not spend real money — which is a good instinct applied to a network
    // that has no listings on it. The published example could never have completed a call:
    // the catalogue is `eip155:8453` only, so every tool it built would have refused to pay.
    // An automated reviewer on the AI SDK registry caught it; this test had been holding it
    // in place.
    expect(EXAMPLE).toMatch(/networks:\s*\['base'\]/);
  });

  it('says plainly that it spends real money', () => {
    // Safety now comes from the guards and from saying so, not from a network nobody serves.
    expect(EXAMPLE).toMatch(/REAL USDC/);
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
