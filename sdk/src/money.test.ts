import { describe, expect, it } from 'vitest';

import { NETWORKS } from './constants.js';
import { formatUsdc, parseUsdc, quoteToUsd } from './money.js';

describe('usdc amounts', () => {
  it('round-trips through atomic units', () => {
    expect(parseUsdc('0.002')).toBe(2_000n);
    expect(parseUsdc('1.25')).toBe(1_250_000n);
    expect(formatUsdc(2_000n)).toBe('0.002');
    expect(formatUsdc(10_000_000n)).toBe('10');
  });

  it('rejects prices USDC cannot represent', () => {
    expect(() => parseUsdc('0.0000001')).toThrow(RangeError);
    expect(() => parseUsdc('-1')).toThrow(RangeError);
    expect(() => parseUsdc('1e6')).toThrow(RangeError);
  });
});

describe('pricing a quote for guards', () => {
  it('prices known USDC contracts at 6 decimals', () => {
    expect(quoteToUsd({ amountAtomic: '2000', asset: NETWORKS.base.usdc })).toBe(0.002);
    expect(
      quoteToUsd({ amountAtomic: '1000000', asset: NETWORKS['base-sepolia'].usdc.toUpperCase() }),
    ).toBe(1);
  });

  it('uses declared decimals for an unrecognised asset', () => {
    expect(quoteToUsd({ amountAtomic: '5000000000000000000', asset: '0xdead', decimals: 18 })).toBe(
      5,
    );
  });

  it('fails closed on an asset it cannot price', () => {
    // Guessing here would let an unknown token slip past a spend cap, and the payment
    // is irreversible.
    expect(() => quoteToUsd({ amountAtomic: '1000', asset: '0xdead' })).toThrow(RangeError);
    expect(() => quoteToUsd({ amountAtomic: 'lots', asset: NETWORKS.base.usdc })).toThrow(
      RangeError,
    );
  });
});
