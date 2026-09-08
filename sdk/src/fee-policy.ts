import { parseUsdc } from './money.js';

/** Days of 0% fee, counted from the provider's registration — not from a listing's. */
export const PROMO_DAYS = 30;

/** Platform fee once the promo ends: a flat 2%, with no minimum. */
export const STANDARD_FEE_BPS = 200;

/**
 * The smallest price a listing may carry, in USDC atomic units ($0.0001).
 *
 * An **anti-dust floor, not a fee rule.** It exists because a listing priced in single
 * base units is indistinguishable from a mistake and clogs the chain with transfers worth
 * less than the gas that carries them. The fee has no minimum of its own: at this floor
 * the platform takes 2 base units and the provider keeps 98.
 */
export const MIN_LISTING_PRICE_ATOMIC = parseUsdc('0.0001');

export type FeePhase = 'promo' | 'standard';

/**
 * Why a listing cannot currently be served.
 *
 * One reason, deliberately. The provider is past their promo but no splitter contract is
 * configured, so a fee-bearing payment has nowhere to settle. The listing must fail
 * loudly rather than quietly reverting to direct payment, which would hand the platform's
 * fee to the provider without either party being told.
 *
 * A price-based block used to exist, when the fee carried a $0.001 minimum that could
 * exceed a cheap listing's price. The fee is now a flat 2% with no minimum, so no price
 * can be too low to earn from — a $0.0001 call yields the provider 98 base units.
 */
export type FeeBlock = 'missing_splitter';

export interface FeePolicyInput {
  /** The provider's registration timestamp. This is the clock, and it never resets. */
  providerCreatedAt: Date;
  now: Date;
  /** The listing's price, in USDC atomic units. */
  priceAtomic: bigint;
  providerWallet: string;
  /** The deployed splitter, if there is one. */
  splitterAddress?: string | null;
}

export interface FeePolicy {
  phase: FeePhase;
  /** The instant the promo stops applying. Exposed so the dashboard can name the date. */
  promoEndsAt: Date;
  /** Address the 402 should quote. The provider during promo; the splitter after. */
  payTo: string | null;
  feeBps: number;
  feeAtomic: bigint;
  providerReceivesAtomic: bigint;
  /** Null when the listing can be served. Otherwise the reason it cannot. */
  blockedBy: FeeBlock | null;
}

/** The moment a provider's promotional period ends. */
export function promoEndsAt(providerCreatedAt: Date): Date {
  return new Date(providerCreatedAt.getTime() + PROMO_DAYS * 24 * 60 * 60 * 1000);
}

/** Whole days until the promo ends. Negative once it has. Used for the deadline alarm. */
export function daysUntilPromoEnds(providerCreatedAt: Date, now: Date): number {
  const ms = promoEndsAt(providerCreatedAt).getTime() - now.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Resolves who is paid, and how much of it is a fee.
 *
 * The promotional clock runs from the **provider's** registration, not a listing's. A
 * provider who delists and re-lists a tool, or lists a tenth tool in month six, does not
 * get another free month: the input is `providers.created_at` and nothing a listing can
 * do reaches it.
 *
 * The boundary is exclusive — at exactly `PROMO_DAYS` the promo is over. A promo that
 * still applied on its final instant would be 30 days plus an epsilon, and "30 days" is
 * what the terms say.
 *
 * Nothing here custodies anything. During the promo the payer pays the provider directly.
 * Afterwards they pay a splitter contract that divides the transfer on-chain — the
 * platform is a payee of the fee, never a holder of the provider's revenue.
 */
export function resolveFeePolicy(input: FeePolicyInput): FeePolicy {
  const ends = promoEndsAt(input.providerCreatedAt);
  const phase: FeePhase = input.now.getTime() < ends.getTime() ? 'promo' : 'standard';

  if (phase === 'promo') {
    return {
      phase,
      promoEndsAt: ends,
      payTo: input.providerWallet,
      feeBps: 0,
      feeAtomic: 0n,
      providerReceivesAtomic: input.priceAtomic,
      blockedBy: null,
    };
  }

  const feeAtomic = platformFee(input.priceAtomic);

  if (!input.splitterAddress) {
    return {
      phase,
      promoEndsAt: ends,
      payTo: null,
      feeBps: STANDARD_FEE_BPS,
      feeAtomic,
      providerReceivesAtomic: input.priceAtomic - feeAtomic,
      blockedBy: 'missing_splitter',
    };
  }

  return {
    phase,
    promoEndsAt: ends,
    payTo: input.splitterAddress,
    feeBps: STANDARD_FEE_BPS,
    feeAtomic,
    providerReceivesAtomic: input.priceAtomic - feeAtomic,
    blockedBy: null,
  };
}

/**
 * The platform's cut of a payment, in USDC base units.
 *
 * `floor(gross * 2%)`, computed in integers. Two properties matter and are tested by
 * fuzzing rather than by example:
 *
 *   - `fee + providerReceives === gross`, always. Nothing is created or lost in the split.
 *   - the fee never rounds **up**. Where a remainder exists it goes to the provider, so
 *     the platform can only ever take less than its nominal share, never more. Rounding
 *     in the platform's favour would be a fraction of a base unit per call and an
 *     indefensible default.
 *
 * The Solidity splitter implements this exact expression, and both are checked against
 * shared vectors so the on-chain and off-chain answers cannot drift.
 */
export function platformFee(grossAtomic: bigint): bigint {
  if (grossAtomic <= 0n) return 0n;
  return (grossAtomic * BigInt(STANDARD_FEE_BPS)) / 10_000n;
}

/** Human-readable reason, for an API response or an admin screen. */
export function describeBlock(block: FeeBlock): string {
  switch (block) {
    case 'missing_splitter':
      return 'This provider’s promotional period has ended and no splitter contract is configured, so a fee-bearing payment has nowhere to settle. The listing cannot be served until the splitter factory is configured and this provider’s splitter is deployed.';
  }
}
