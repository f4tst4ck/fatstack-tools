import { STANDARD_FEE_BPS } from './fee-policy.js';

export type FeeMode = 'direct' | 'splitter';

export interface PayeeResolution {
  /** The single address that receives the transfer. */
  payTo: string;
  /** Platform fee in basis points. 0 under `direct`; 200 under `splitter`. */
  feeBps: number;
}

/**
 * Resolves who is paid for a call.
 *
 * Under `direct` this is always, and only, the provider's own wallet — the platform is
 * never a payee and never custodies funds.
 *
 * Under `splitter` it is the provider's own splitter contract, which forwards 98% to them
 * and 2% to the treasury atomically. The platform still never holds the money: the
 * contract has no owner, no pause and no withdrawal, and the two transfers happen in the
 * same transaction as the payment.
 *
 * `splitterAddress` must be the splitter belonging to *this* provider. There is one per
 * provider by design — the provider is fixed at construction, because an unsigned
 * provider argument would let anyone who observed a payment authorisation redirect it.
 * Passing a shared or wrong address would pay someone else, irreversibly, so an absent
 * one throws rather than falling back to paying the provider directly and silently
 * handing them the platform's fee.
 */
export function resolvePayee(
  mode: FeeMode,
  providerWallet: string,
  splitterAddress?: string | null,
): PayeeResolution {
  switch (mode) {
    case 'direct':
      return { payTo: providerWallet, feeBps: 0 };
    case 'splitter': {
      if (!splitterAddress) {
        throw new Error(
          "FEE_MODE=splitter requires this provider's deployed splitter address " +
            '(set SPLITTER_ADDRESS, or pass `splitterAddress`). Refusing to fall back to ' +
            'paying the wallet directly, which would quietly waive the platform fee.',
        );
      }
      return { payTo: splitterAddress, feeBps: STANDARD_FEE_BPS };
    }
  }
}
