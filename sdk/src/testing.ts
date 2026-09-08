import type { FacilitatorClient } from '@x402/core/server';

export interface MockFacilitatorOptions {
  /** Reject verification with this reason instead of accepting. */
  invalidReason?: string;
  /** Fail settlement with this reason after a successful verify. */
  settleErrorReason?: string;
  transaction?: string;
  payer?: string;
}

export interface MockFacilitator extends FacilitatorClient {
  readonly verifyCalls: number;
  readonly settleCalls: number;
}

/**
 * A facilitator stand-in for tests. Nothing here talks to a chain or a network: the
 * official packages own signing and verification, so what we exercise is our own
 * behaviour around their results.
 */
export function createMockFacilitator(options: MockFacilitatorOptions = {}): MockFacilitator {
  let verifyCalls = 0;
  let settleCalls = 0;

  return {
    async verify() {
      verifyCalls += 1;
      return options.invalidReason
        ? { isValid: false, invalidReason: options.invalidReason }
        : { isValid: true, payer: options.payer ?? '0x2222222222222222222222222222222222222222' };
    },
    async settle() {
      settleCalls += 1;
      if (options.settleErrorReason) {
        return {
          success: false,
          errorReason: options.settleErrorReason,
          transaction: '',
          network: 'eip155:8453',
        };
      }
      return {
        success: true,
        transaction: options.transaction ?? `0x${'ab'.repeat(32)}`,
        network: 'eip155:8453',
        payer: options.payer ?? '0x2222222222222222222222222222222222222222',
      };
    },
    async getSupported() {
      return {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
          { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
        ],
        extensions: [],
        signers: {},
      };
    },
    get verifyCalls() {
      return verifyCalls;
    },
    get settleCalls() {
      return settleCalls;
    },
  };
}
