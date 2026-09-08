import { describe, expect, it } from 'vitest';

import { parseUsdc } from './money.js';
import {
  MIN_LISTING_PRICE_ATOMIC,
  PROMO_DAYS,
  STANDARD_FEE_BPS,
  daysUntilPromoEnds,
  describeBlock,
  platformFee,
  promoEndsAt,
  resolveFeePolicy,
} from './fee-policy.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const SPLITTER = '0x2222222222222222222222222222222222222222';
const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const at = (days: number, ms = 0) => new Date(REGISTERED.getTime() + days * DAY + ms);

const policy = (overrides: Partial<Parameters<typeof resolveFeePolicy>[0]> = {}) =>
  resolveFeePolicy({
    providerCreatedAt: REGISTERED,
    now: at(1),
    priceAtomic: parseUsdc('1.00'),
    providerWallet: WALLET,
    splitterAddress: SPLITTER,
    ...overrides,
  });

describe('the promotional window', () => {
  it('pays the provider directly, with no fee, during the promo', () => {
    const p = policy({ now: at(1) });
    expect(p.phase).toBe('promo');
    expect(p.payTo).toBe(WALLET);
    expect(p.feeAtomic).toBe(0n);
    expect(p.providerReceivesAtomic).toBe(parseUsdc('1.00'));
    expect(p.blockedBy).toBeNull();
  });

  it('still applies one millisecond before the boundary', () => {
    expect(policy({ now: at(PROMO_DAYS, -1) }).phase).toBe('promo');
  });

  it('has ended at exactly 30 days', () => {
    // Exclusive on purpose. A promo that still applied on its final instant would be
    // thirty days plus an epsilon, and "30 days" is what the terms promise.
    expect(policy({ now: at(PROMO_DAYS) }).phase).toBe('standard');
  });

  it('reports the end date so the dashboard can name it', () => {
    expect(promoEndsAt(REGISTERED).toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('counts down whole days, and goes negative once expired', () => {
    expect(daysUntilPromoEnds(REGISTERED, at(16))).toBe(14);
    expect(daysUntilPromoEnds(REGISTERED, at(30))).toBe(0);
    expect(daysUntilPromoEnds(REGISTERED, at(45))).toBe(-15);
  });
});

describe('the clock belongs to the provider, not the listing', () => {
  it('cannot be reset by anything a listing does', () => {
    // The only input is providers.created_at. Re-listing a tool, delisting and
    // re-registering it, or adding a tenth tool in month six all resolve identically,
    // because none of them can reach this value.
    const reRegisteredLater = policy({ now: at(45), priceAtomic: parseUsdc('1.00') });
    expect(reRegisteredLater.phase).toBe('standard');

    // Same provider, same registration date, a brand-new listing today: still standard.
    const brandNewListing = resolveFeePolicy({
      providerCreatedAt: REGISTERED,
      now: at(45),
      priceAtomic: parseUsdc('0.50'),
      providerWallet: WALLET,
      splitterAddress: SPLITTER,
    });
    expect(brandNewListing.phase).toBe('standard');
    expect(brandNewListing.promoEndsAt).toEqual(promoEndsAt(REGISTERED));
  });
});

describe('the standard fee', () => {
  it('takes a flat 2% once the promo ends, and routes payment to the splitter', () => {
    const p = policy({ now: at(31), priceAtomic: parseUsdc('1.00') });
    expect(p.phase).toBe('standard');
    expect(p.feeBps).toBe(STANDARD_FEE_BPS);
    expect(p.feeAtomic).toBe(parseUsdc('0.02'));
    expect(p.providerReceivesAtomic).toBe(parseUsdc('0.98'));
    expect(p.payTo).toBe(SPLITTER);
  });

  it('has no minimum: a cheap call still earns the provider almost all of it', () => {
    // Under the old $0.001 minimum this listing could not be served at all. A flat 2%
    // takes 1 base unit of 50 and leaves 49.
    const p = policy({ now: at(31), priceAtomic: parseUsdc('0.00005') });
    expect(p.feeAtomic).toBe(1n);
    expect(p.providerReceivesAtomic).toBe(49n);
    expect(p.blockedBy).toBeNull();
  });

  it('computes the fee in integers, never through a float', () => {
    // 2% of $0.075 is exactly $0.0015. A float lands on 0.0014999999999999999.
    const p = policy({ now: at(31), priceAtomic: parseUsdc('0.075') });
    expect(p.feeAtomic).toBe(parseUsdc('0.0015'));
  });
});

describe('the rounding rule', () => {
  it('floors, so the platform can never take more than its nominal share', () => {
    // 2% of 149 base units is 2.98. Rounding up would take 3 — a fraction of a base unit
    // per call, in the platform's favour, by default. It takes 2.
    expect(platformFee(149n)).toBe(2n);
    expect(platformFee(99n)).toBe(1n);
    expect(platformFee(49n)).toBe(0n);
  });

  it('takes nothing from amounts too small to have a 2%', () => {
    for (const gross of [0n, 1n, 10n, 49n]) {
      expect(platformFee(gross)).toBe(0n);
    }
  });

  it('never creates or destroys value, across the whole price range', () => {
    // Property, fuzzed: the split is exact at every magnitude from one base unit to
    // ten thousand dollars. Any discrepancy here is money appearing or vanishing.
    const cases: bigint[] = [];
    for (let exp = 0; exp <= 10; exp += 1) cases.push(10n ** BigInt(exp));
    for (let i = 0; i < 2_000; i += 1) {
      cases.push(BigInt(Math.floor(Math.random() * 10_000_000_000)));
    }
    for (const gross of cases) {
      const fee = platformFee(gross);
      const provider = gross - fee;
      expect(fee + provider).toBe(gross);
      expect(fee).toBeGreaterThanOrEqual(0n);
      expect(provider).toBeGreaterThanOrEqual(0n);
      // Never rounds up: the fee is at most the exact 2%, never beyond it.
      expect(fee * 10_000n).toBeLessThanOrEqual(gross * BigInt(STANDARD_FEE_BPS));
    }
  });

  it('agrees with the shared vectors the Solidity splitter is tested against', () => {
    // These exact pairs live in contracts/test/vectors.json. If the two implementations
    // ever disagree, an on-chain split and the figure we quote diverge — and the payment
    // is final by the time anyone notices.
    const vectors: [bigint, bigint][] = [
      [0n, 0n],
      [1n, 0n],
      [49n, 0n],
      [50n, 1n],
      [99n, 1n],
      [100n, 2n],
      [149n, 2n],
      [500n, 10n],
      [1_000n, 20n],
      [10_000n, 200n],
      [1_000_000n, 20_000n],
      [999_999n, 19_999n],
    ];
    for (const [gross, expected] of vectors) {
      expect(platformFee(gross)).toBe(expected);
    }
  });
});

describe('listings that cannot be served', () => {
  it('blocks, rather than reverting to direct, when no splitter is configured', () => {
    // Silently paying the provider directly would hand them the platform's fee without
    // either side being told, and would make the terms we publish untrue.
    const p = policy({ now: at(31), splitterAddress: null });
    expect(p.blockedBy).toBe('missing_splitter');
    expect(p.payTo).toBeNull();
    expect(describeBlock('missing_splitter')).toContain('splitter');
  });

  it('treats an empty splitter address as absent', () => {
    expect(policy({ now: at(31), splitterAddress: '' }).blockedBy).toBe('missing_splitter');
  });

  it('no longer blocks a cheap listing — that rule died with the minimum fee', () => {
    // The five seed tools at $0.0005 were scheduled to go dark under the old minimum.
    const p = policy({ now: at(31), priceAtomic: parseUsdc('0.0005') });
    expect(p.blockedBy).toBeNull();
    expect(p.providerReceivesAtomic).toBe(490n);
    expect(p.feeAtomic).toBe(10n);
  });

  it('never blocks during the promo, whatever the price', () => {
    const p = policy({ now: at(1), priceAtomic: parseUsdc('0.0005'), splitterAddress: null });
    expect(p.blockedBy).toBeNull();
    expect(p.payTo).toBe(WALLET);
  });
});

describe('the anti-dust listing floor', () => {
  it('is a price rule, not a fee rule', () => {
    // $0.0001 exists because a listing priced in single base units is indistinguishable
    // from a mistake, not because the fee needs a minimum — it does not have one.
    expect(MIN_LISTING_PRICE_ATOMIC).toBe(parseUsdc('0.0001'));
    expect(platformFee(MIN_LISTING_PRICE_ATOMIC)).toBe(2n);
  });
});
