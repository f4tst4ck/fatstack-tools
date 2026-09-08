import { decodePaymentResponseHeader } from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { FacilitatorClient, RouteConfig } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { z } from 'zod';

import { DOCS_URL, NETWORKS, NO_REFUNDS_NOTICE } from './constants.js';
import type { NetworkName } from './constants.js';
import { readPaywallEnv } from './env.js';
import { resolvePayee } from './fee-mode.js';
import { formatUsdc, parseUsdc } from './money.js';

const optionsSchema = z.object({
  /** Price per call in USD, as a decimal string: "0.002". */
  price: z.string().regex(/^\d+(?:\.\d{1,6})?$/, 'price must be USD with at most 6 decimals'),
  /** The provider's own wallet. Under FEE_MODE=direct this is the sole payee. */
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'wallet must be a 20-byte address'),
  /**
   * This provider's splitter contract. Required when FEE_MODE=splitter; ignored under
   * `direct`. Falls back to SPLITTER_ADDRESS from the environment.
   */
  splitterAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'splitterAddress must be a 20-byte address')
    .optional(),
  toolId: z.string().min(1).max(128),
  network: z.enum(['base', 'base-sepolia']).default('base'),
  description: z.string().optional(),
  docsUrl: z.string().url().default(DOCS_URL),
  mimeType: z.string().default('application/json'),
  maxTimeoutSeconds: z.number().int().positive().default(60),
});

export interface PaywallOptions extends z.input<typeof optionsSchema> {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injects a facilitator instead of building an HTTP one. Used by tests. */
  facilitator?: FacilitatorClient;
}

/** The 402 body an agent reads before deciding to pay. */
export interface UnpaidBody {
  error: 'payment_required';
  tool: string;
  price: { usdc: string; amountAtomic: string; asset: string; network: string };
  payTo: string;
  terms: { refundable: false; notice: string };
  docs: string;
  message: string;
  /**
   * How the payment settles. `direct` pays the provider's wallet; `splitter` pays a
   * contract that forwards the provider's share and the platform fee in the same
   * transaction. Either way the agent pays exactly `price`, once, and it is final.
   */
  settlement: { via: 'direct' | 'splitter'; feeBps: number };
}

/**
 * The framework-agnostic core of a paywall.
 *
 * Adapters live behind their own subpath exports (`@fatstack/x402/hono`, `/express`,
 * `/next`) rather than as methods here. A method would have to reach its adapter through
 * a dynamic import, which bundlers cannot statically analyse — the Worker build silently
 * omitted `@x402/hono` and failed at runtime with MissingAdapterError. Separate entry
 * points let each build pull in exactly the adapter it uses and nothing else, which also
 * keeps `next` out of a Cloudflare Worker bundle.
 */
export interface Paywall {
  /** The x402 route config, handed to an official adapter. */
  routeConfig: RouteConfig;
  /** Pre-configured resource server, shared by every adapter. */
  server: x402ResourceServer;
  /** Resolved payee. Always the provider wallet while FEE_MODE=direct. */
  payTo: string;
  /** True when KILLSWITCH=1: adapters must answer 503 without taking payment. */
  killed: boolean;
  killswitchBody: { error: string; message: string };
  /** Derives the indexing reference from a settlement receipt header. */
  paymentRef(settlementHeader: string | null | undefined): string | null;
}

const KILLSWITCH_BODY = {
  error: 'service_unavailable',
  message:
    'This tool is temporarily disabled by its operator (KILLSWITCH). No payment was taken. Try again later.',
} as const;

/**
 * Paywalls a route with x402: USDC on Base, paid directly to the provider's wallet.
 *
 * Verification and settlement are delegated to the official x402 packages against the
 * hosted facilitator — this module does not sign or verify anything itself.
 *
 * Under FEE_MODE=splitter the payee is this provider's splitter contract instead. That is
 * resolved at construction, so a missing address fails at start-up rather than mid-request:
 * silently falling back to `direct` would pay the wrong party.
 */
export function paywall(options: PaywallOptions): Paywall {
  const config = optionsSchema.parse(options);
  const env = readPaywallEnv(options.env);
  const network = NETWORKS[config.network as NetworkName];

  // Resolved at construction: a misconfigured payee should stop the process starting,
  // not surface as a 402 quoting the wrong address to an agent that will pay it.
  const { payTo, feeBps } = resolvePayee(
    env.FEE_MODE,
    config.wallet,
    config.splitterAddress ?? env.SPLITTER_ADDRESS,
  );
  const viaSplitter = env.FEE_MODE === 'splitter';

  const amountAtomic = parseUsdc(config.price).toString();
  const priceUsdc = formatUsdc(parseUsdc(config.price));

  const unpaidBody: UnpaidBody = {
    error: 'payment_required',
    tool: config.toolId,
    price: {
      usdc: priceUsdc,
      amountAtomic,
      asset: network.usdc,
      network: network.caip2,
    },
    payTo,
    terms: { refundable: false, notice: NO_REFUNDS_NOTICE },
    docs: config.docsUrl,
    settlement: { via: viaSplitter ? 'splitter' : 'direct', feeBps },
    message:
      `This call costs ${priceUsdc} USDC on ${config.network}, paid ` +
      (viaSplitter
        ? "to the provider's payment splitter, which forwards their share and the platform fee in the same transaction"
        : 'directly to the provider') +
      `. ${NO_REFUNDS_NOTICE} See ${config.docsUrl}`,
  };

  const routeConfig: RouteConfig = {
    accepts: {
      scheme: 'exact',
      network: network.caip2,
      payTo,
      // An explicit asset+amount pins USDC and the exact atomic amount, rather than
      // leaving the quote to a price feed.
      // A dollar price, not an explicit { asset, amount }: the EVM scheme resolves the
      // network's default asset (USDC) and publishes its EIP-712 domain in `extra`, which
      // the payer needs to sign the EIP-3009 authorisation. Naming the asset directly
      // skips that lookup and emits `extra: {}`, which nobody can pay against.
      price: `$${priceUsdc}`,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
    },
    description: config.description ?? `Fatstack tool ${config.toolId}`,
    mimeType: config.mimeType,
    unpaidResponseBody: () => ({ contentType: 'application/json', body: unpaidBody }),
  };

  const facilitator: FacilitatorClient =
    options.facilitator ??
    new HTTPFacilitatorClient({
      url: env.FACILITATOR_URL,
      ...(env.FACILITATOR_API_KEY
        ? {
            createAuthHeaders: async () => ({
              verify: { authorization: `Bearer ${env.FACILITATOR_API_KEY}` },
              settle: { authorization: `Bearer ${env.FACILITATOR_API_KEY}` },
              supported: { authorization: `Bearer ${env.FACILITATOR_API_KEY}` },
            }),
          }
        : {}),
    });

  const server = new x402ResourceServer(facilitator).register(network.caip2, new ExactEvmScheme());

  const killed = env.KILLSWITCH === '1';

  /** Derives the indexing reference from the settlement receipt the adapter emitted. */
  function paymentRef(paymentResponseHeader: string | null | undefined): string | null {
    if (!paymentResponseHeader) return null;
    try {
      const settled = decodePaymentResponseHeader(paymentResponseHeader);
      const transaction = (settled as { transaction?: string }).transaction;
      return transaction ? `${config.toolId}:${network.caip2}:${transaction}` : null;
    } catch {
      return null;
    }
  }

  return {
    routeConfig,
    payTo,
    server,
    killed,
    killswitchBody: KILLSWITCH_BODY,
    paymentRef,
  };
}

export type { FacilitatorClient, RouteConfig } from '@x402/core/server';
