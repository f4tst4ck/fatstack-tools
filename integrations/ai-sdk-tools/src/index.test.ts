import { describe, expect, it, vi } from 'vitest';

import { buildTools, fatstackTools, MissingSpendGuardError, toolNameFor } from './index.js';
import { fetchListings } from './registry.js';

const listing = {
  slug: 'unit-convert',
  name: 'Unit convert',
  description: 'Converts between units.',
  url: 'https://unit-convert.fatstack.net/mcp',
  payment: {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x1111111111111111111111111111111111111111',
    amountUsd: '0.001000',
  },
};

const wallet = { address: '0x2222222222222222222222222222222222222222' } as never;
const registry = (tools: unknown[]) =>
  (async () => new Response(JSON.stringify({ tools }), { status: 200 })) as typeof globalThis.fetch;

describe('spend guards are required, not defaulted', () => {
  it('refuses to build without guards at all', async () => {
    // The failure mode here is a drained wallet while nobody is watching. A default would
    // be us picking a number for someone else's money.
    await expect(
      // @ts-expect-error deliberately omitting the required field
      fatstackTools({ wallet, fetch: registry([listing]) }),
    ).rejects.toThrow(MissingSpendGuardError);
  });

  it('refuses without maxPerDay, even when maxPerCall is set', async () => {
    // A per-call cap does nothing against a thousand cheap calls, which is the shape a
    // runaway agent actually has.
    await expect(
      // @ts-expect-error maxPerDay is required
      fatstackTools({ wallet, guards: { maxPerCall: 0.01 }, fetch: registry([listing]) }),
    ).rejects.toThrow(/maxPerDay/);
  });

  it('refuses a nonsensical cap rather than coercing it', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        fatstackTools({ wallet, guards: { maxPerDay: bad }, fetch: registry([listing]) }),
      ).rejects.toThrow(MissingSpendGuardError);
    }
  });

  it('refuses a per-call cap that the daily cap could never bind', async () => {
    await expect(
      fatstackTools({
        wallet,
        guards: { maxPerDay: 1, maxPerCall: 5 },
        fetch: registry([listing]),
      }),
    ).rejects.toThrow(/never bind/);
  });

  it('fails before touching the network, so the error names the real fault', async () => {
    const spy: typeof globalThis.fetch = vi.fn(async () => new Response('{}'));
    await expect(
      // @ts-expect-error deliberately omitting guards
      fatstackTools({ wallet, fetch: spy }),
    ).rejects.toThrow(MissingSpendGuardError);
    expect(spy, 'a missing cap should not look like a connectivity problem').not.toHaveBeenCalled();
  });

  it('says what to do, not merely what was wrong', async () => {
    // @ts-expect-error deliberately omitting guards
    const error = await fatstackTools({ wallet, fetch: registry([]) }).catch((e: Error) => e);
    expect(error.message).toMatch(/maxPerDay/);
    expect(error.message).toMatch(/willing to lose/);
  });

  it('accepts a valid guard and builds tools', async () => {
    const tools = await fatstackTools({
      wallet,
      guards: { maxPerDay: 1, maxPerCall: 0.01 },
      fetch: registry([listing]),
    });
    expect(Object.keys(tools)).toEqual(['unit_convert']);
  });
});

describe('building tools from listings', () => {
  const guards = { maxPerDay: 1 };

  it('names tools so the AI SDK accepts them', () => {
    expect(toolNameFor({ slug: 'unit-convert' })).toBe('unit_convert');
    expect(toolNameFor({ slug: 'a.b/c-d' })).toBe('a_b_c_d');
    expect(toolNameFor({ slug: '---' })).toBe('fatstack_tool');
  });

  it('puts the price and the no-refunds term in the description the model reads', () => {
    // The model is deciding whether to spend real money; the price belongs where it looks.
    const tools = buildTools([listing], { wallet, guards, networks: ['base'] });
    const description = (tools.unit_convert as { description?: string }).description ?? '';
    expect(description).toContain('$0.001000');
    expect(description).toMatch(/no refunds/i);
  });

  it('builds one tool per listing', () => {
    const second = { ...listing, slug: 'echo', name: 'Echo' };
    const tools = buildTools([listing, second], { wallet, guards, networks: ['base'] });
    expect(Object.keys(tools).sort()).toEqual(['echo', 'unit_convert']);
  });
});

describe('reading the catalogue', () => {
  it('filters by network, so a mainnet wallet is never offered a testnet listing', async () => {
    const sepolia = {
      ...listing,
      slug: 'testnet-tool',
      payment: { ...listing.payment, network: 'eip155:84532' },
    };
    const found = await fetchListings({
      fetch: registry([listing, sepolia]),
      network: 'eip155:8453',
    });
    expect(found.map((l) => l.slug)).toEqual(['unit-convert']);
  });

  it('filters by price before the agent ever sees the tool', async () => {
    const dear = {
      ...listing,
      slug: 'expensive',
      payment: { ...listing.payment, amountUsd: '5.000000' },
    };
    const found = await fetchListings({ fetch: registry([listing, dear]), maxPriceUsd: 0.01 });
    expect(found.map((l) => l.slug)).toEqual(['unit-convert']);
  });

  it('throws on an unreadable registry rather than returning an empty catalogue', async () => {
    // Silently returning nothing would look like "no tools available" instead of "we could
    // not read the catalogue", and the agent would carry on as if that were the answer.
    const failing = (async () => new Response('nope', { status: 500 })) as typeof globalThis.fetch;
    await expect(fetchListings({ fetch: failing })).rejects.toThrow(/500/);
  });

  it('rejects a registry whose shape it does not recognise', async () => {
    const wrong = (async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof globalThis.fetch;
    await expect(fetchListings({ fetch: wrong })).rejects.toThrow(/expected shape/);
  });
});
