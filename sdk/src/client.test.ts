import { describe, expect, it, vi } from 'vitest';

import { NETWORKS } from './constants.js';
import { PaymentRejectedError, SpendGuardError, UnreadableQuoteError } from './errors.js';
import { evaluateGuards, payFetch } from './client.js';
import { createMemorySpendStore } from './store.js';
import type { EvmWallet } from './client.js';

const PROVIDER = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';

/** A signer that records what it was asked to sign, so we can assert it was never asked. */
function recordingWallet() {
  const signTypedData = vi.fn().mockResolvedValue(`0x${'ab'.repeat(65)}`);
  return {
    wallet: { address: AGENT, signTypedData, type: 'local' } as Partial<EvmWallet> as EvmWallet,
    signTypedData,
  };
}

function quote(amountAtomic: string) {
  return {
    x402Version: 2,
    error: 'payment_required',
    accepts: [
      {
        scheme: 'exact',
        network: NETWORKS.base.caip2,
        asset: NETWORKS.base.usdc,
        amount: amountAtomic,
        maxAmountRequired: amountAtomic,
        payTo: PROVIDER,
        resource: 'https://sentiment.fatstack.net/run',
        description: 'test',
        mimeType: 'application/json',
        maxTimeoutSeconds: 60,
      },
    ],
  };
}

function facilitatorless(amountAtomic = '2000') {
  return vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(quote(amountAtomic), { status: 402 }),
  );
}

describe('allowedHosts guard', () => {
  it('refuses an unlisted host before any network call is made', async () => {
    const { wallet, signTypedData } = recordingWallet();
    const fetchMock = facilitatorless();

    await expect(
      payFetch('https://evil.example.com/run', undefined, {
        wallet,
        fetch: fetchMock,
        guards: { allowedHosts: ['fatstack.net'] },
      }),
    ).rejects.toThrow(SpendGuardError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('allows subdomains of a listed host', async () => {
    const { wallet } = recordingWallet();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));

    const response = await payFetch('https://sentiment.fatstack.net/run', undefined, {
      wallet,
      fetch: fetchMock,
      guards: { allowedHosts: ['fatstack.net'] },
    });

    expect(response.status).toBe(200);
  });

  it('reports which guard refused', async () => {
    const { wallet } = recordingWallet();
    await payFetch('https://ok.fatstack.net/x', undefined, {
      wallet,
      fetch: vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true })),
      guards: { allowedHosts: ['fatstack.net'] },
    });

    const error = await payFetch('https://nope.example.com/x', undefined, {
      wallet,
      fetch: facilitatorless(),
      guards: { allowedHosts: ['fatstack.net'] },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpendGuardError);
    expect((error as SpendGuardError).guard).toBe('allowedHosts');
    expect((error as SpendGuardError).detail.host).toBe('nope.example.com');
  });
});

describe('maxPerCall guard', () => {
  it('throws before signing when the quote exceeds the per-call ceiling', async () => {
    const { wallet, signTypedData } = recordingWallet();

    const error = await payFetch('https://sentiment.fatstack.net/run', undefined, {
      wallet,
      fetch: facilitatorless('2000'), // $0.002
      guards: { maxPerCall: 0.001 },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpendGuardError);
    expect((error as SpendGuardError).guard).toBe('maxPerCall');
    // The point of the guard: nothing was signed, so nothing can be spent.
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('rolling window guards', () => {
  const store = () => createMemorySpendStore();

  it('maxPerHour counts spend inside the last hour', async () => {
    const s = store();
    const now = 1_700_000_000_000;
    await s.record({ at: now - 10 * 60 * 1000, usd: 0.9 });

    await expect(evaluateGuards(0.2, { maxPerHour: 1 }, s, now)).rejects.toThrow(SpendGuardError);
    await expect(evaluateGuards(0.05, { maxPerHour: 1 }, s, now)).resolves.toBeUndefined();
  });

  it('maxPerHour ignores spend that has aged out of the window', async () => {
    const s = store();
    const now = 1_700_000_000_000;
    await s.record({ at: now - 61 * 60 * 1000, usd: 5 });

    await expect(evaluateGuards(0.5, { maxPerHour: 1 }, s, now)).resolves.toBeUndefined();
  });

  it('maxPerDay counts spend inside the last 24 hours', async () => {
    const s = store();
    const now = 1_700_000_000_000;
    await s.record({ at: now - 20 * 60 * 60 * 1000, usd: 9.8 });

    await expect(evaluateGuards(0.5, { maxPerDay: 10 }, s, now)).rejects.toThrow(SpendGuardError);
    await expect(evaluateGuards(0.1, { maxPerDay: 10 }, s, now)).resolves.toBeUndefined();
  });

  it('maxPerDay ignores spend older than a day', async () => {
    const s = store();
    const now = 1_700_000_000_000;
    await s.record({ at: now - 25 * 60 * 60 * 1000, usd: 100 });

    await expect(evaluateGuards(1, { maxPerDay: 10 }, s, now)).resolves.toBeUndefined();
  });

  it('enforces the hourly window through payFetch, before signing', async () => {
    const { wallet, signTypedData } = recordingWallet();
    const s = store();
    const now = 1_700_000_000_000;
    await s.record({ at: now - 60_000, usd: 0.999 });

    const error = await payFetch('https://sentiment.fatstack.net/run', undefined, {
      wallet,
      fetch: facilitatorless('2000'),
      store: s,
      now: () => now,
      guards: { maxPerHour: 1 },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpendGuardError);
    expect((error as SpendGuardError).guard).toBe('maxPerHour');
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('no guards configured', () => {
  it('passes a non-402 response straight through without touching the wallet', async () => {
    const { wallet, signTypedData } = recordingWallet();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json({ result: 'free' }));

    const response = await payFetch('https://sentiment.fatstack.net/run', undefined, {
      wallet,
      fetch: fetchMock,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'free' });
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('spend store', () => {
  it('sums only entries inside the window', async () => {
    const s = createMemorySpendStore();
    await s.record({ at: 1000, usd: 1 });
    await s.record({ at: 2000, usd: 2 });

    expect(await s.totalSince(0)).toBe(3);
    expect(await s.totalSince(1500)).toBe(2);
    expect(await s.totalSince(5000)).toBe(0);
  });
});

describe('an unreadable 402', () => {
  const opts = (wallet: EvmWallet) => ({ wallet, networks: ['base' as const], guards: {} });

  it('is reported as a rejected payment when the request already carried one', async () => {
    const { wallet, signTypedData } = recordingWallet();
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () => new Response('settlement failed: insufficient gas', { status: 402 }),
    );

    await expect(
      payFetch(
        'https://tool.fatstack.net/run',
        { headers: { 'payment-signature': 'already-signed' } },
        { ...opts(wallet), fetch: fetchImpl },
      ),
    ).rejects.toBeInstanceOf(PaymentRejectedError);

    // The signature was already spent upstream; we must not sign a second one.
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('is reported as an unreadable quote when no payment was sent', async () => {
    const { wallet } = recordingWallet();
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () => new Response('nope', { status: 402 }),
    );

    await expect(
      payFetch('https://tool.fatstack.net/run', {}, { ...opts(wallet), fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(UnreadableQuoteError);
  });
});
