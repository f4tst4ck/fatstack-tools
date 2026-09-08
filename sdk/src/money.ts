import { NETWORKS, USDC_DECIMALS } from './constants.js';

const UNITS_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/** "1.25" -> 1250000n. Rejects anything that is not a plain non-negative decimal. */
export function parseUsdc(input: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!match) {
    throw new RangeError(`Not a USDC amount with at most ${USDC_DECIMALS} decimals: ${input}`);
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0') || '0');
  return whole * UNITS_PER_USDC + fraction;
}

/** 1250000n -> "1.25". Trailing zeros trimmed. */
export function formatUsdc(atomic: bigint): string {
  if (atomic < 0n) throw new RangeError('USDC amounts are never negative');
  const whole = atomic / UNITS_PER_USDC;
  const fraction = (atomic % UNITS_PER_USDC).toString().padStart(USDC_DECIMALS, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

const USDC_ADDRESSES = new Set(
  Object.values(NETWORKS).map((network) => network.usdc.toLowerCase()),
);

/**
 * Converts a quoted amount to USD for guard evaluation.
 *
 * Fails closed: if the asset is not a USDC contract we recognise and the quote carries no
 * usable `decimals`, this throws rather than guessing. Guessing here would let an
 * unrecognised token slip past a spend cap, and the payment is irreversible.
 */
export function quoteToUsd(quote: {
  amountAtomic: string;
  asset: string;
  decimals?: number | undefined;
}): number {
  const decimals = USDC_ADDRESSES.has(quote.asset.toLowerCase()) ? USDC_DECIMALS : quote.decimals;

  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(
      `Cannot price asset ${quote.asset}: unknown decimals. Refusing to evaluate spend guards against an unpriceable quote.`,
    );
  }

  if (!/^\d+$/.test(quote.amountAtomic)) {
    throw new RangeError(`Quoted amount is not an integer atomic value: ${quote.amountAtomic}`);
  }

  return Number(quote.amountAtomic) / 10 ** decimals;
}
