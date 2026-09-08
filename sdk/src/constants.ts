/** Base networks in CAIP-2 form, which is what x402 v2 speaks. */
/**
 * The EIP-712 domain a payer signs the EIP-3009 authorisation against is **not** listed
 * here on purpose: it differs per network (mainnet USDC is "USD Coin", the Sepolia
 * deployment is "USDC"), and the EVM scheme owns the authoritative table. Quoting a
 * dollar price lets it resolve the asset and publish that domain in the 402; naming an
 * explicit asset bypasses the lookup and emits `extra: {}`, which no payer can sign
 * against.
 */
export const NETWORKS = {
  base: {
    caip2: 'eip155:8453',
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  'base-sepolia': {
    caip2: 'eip155:84532',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

/** USDC is 6 decimals on Base. */
export const USDC_DECIMALS = 6;

/**
 * Required on every 402 body and every payment-facing doc page. A payment is a direct
 * on-chain transfer between two wallets: once settled nobody, Fatstack included, can
 * reverse it.
 */
export const NO_REFUNDS_NOTICE =
  'Payments are final. Once settled on-chain the transfer cannot be reversed, and there are no refunds.';

export const DOCS_URL = 'https://fatstack.net/docs/payments';

/** Correlates a settled payment with the indexer's view of the on-chain transfer. */
export const PAYMENT_REF_HEADER = 'X-Fatstack-Payment-Ref';

/**
 * x402 v2 dropped the `X-` prefix: the settlement receipt is `PAYMENT-RESPONSE` and the
 * payer's payload is `PAYMENT-SIGNATURE`. The v1 spellings are still read so a v1 payer
 * or resource keeps working. Header names are case-insensitive; these are lowercase
 * because `Headers.get` normalises.
 */
export const SETTLEMENT_HEADERS = ['payment-response', 'x-payment-response'] as const;
export const PAYMENT_SIGNATURE_HEADERS = ['payment-signature', 'x-payment'] as const;

/** First settlement receipt present on a response, in either spelling. */
export function readSettlementHeader(headers: Headers): string | null {
  for (const name of SETTLEMENT_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

export const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';
