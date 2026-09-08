import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';

import {
  NETWORKS,
  PAYMENT_REF_HEADER,
  PAYMENT_SIGNATURE_HEADERS,
  readSettlementHeader,
} from './constants.js';
import type { NetworkName } from './constants.js';
import { PaymentRejectedError, SpendGuardError, UnreadableQuoteError } from './errors.js';
import { quoteToUsd } from './money.js';
import { createMemorySpendStore } from './store.js';
import type { SpendStore } from './store.js';

/** The signer the official EVM scheme expects: address + signTypedData, no key handling. */
export type EvmWallet = ConstructorParameters<typeof ExactEvmScheme>[0];

export interface SpendGuards {
  /** Hard USD ceiling for a single call. */
  maxPerCall?: number;
  /** Rolling 60-minute USD ceiling. */
  maxPerHour?: number;
  /** Rolling 24-hour USD ceiling. */
  maxPerDay?: number;
  /** Hostnames this agent may pay. Checked before any network call. */
  allowedHosts?: string[];
}

export interface PayFetchOptions {
  wallet: EvmWallet;
  guards?: SpendGuards;
  /** Defaults to a process-local in-memory store. */
  store?: SpendStore;
  networks?: NetworkName[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hostOf(input: RequestInfo | URL): string | null {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `example.com` in allowedHosts also authorises `tool.example.com`. */
function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const candidate = entry.trim().toLowerCase().replace(/^\*\./, '');
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}

/**
 * Checks every guard against a quote. Returns the USD value if the call may proceed,
 * throws SpendGuardError otherwise. Called before a payment payload exists.
 */
export async function evaluateGuards(
  quoteUsd: number,
  guards: SpendGuards,
  store: SpendStore,
  now: number,
): Promise<void> {
  if (guards.maxPerCall !== undefined && quoteUsd > guards.maxPerCall) {
    throw new SpendGuardError(
      'maxPerCall',
      `Call costs $${quoteUsd} which exceeds the maxPerCall limit of $${guards.maxPerCall}`,
      { limitUsd: guards.maxPerCall, attemptedUsd: quoteUsd },
    );
  }

  if (guards.maxPerHour !== undefined) {
    const spent = await store.totalSince(now - HOUR_MS);
    if (spent + quoteUsd > guards.maxPerHour) {
      throw new SpendGuardError(
        'maxPerHour',
        `Call costs $${quoteUsd} and $${spent} was already spent this hour, exceeding the maxPerHour limit of $${guards.maxPerHour}`,
        { limitUsd: guards.maxPerHour, attemptedUsd: spent + quoteUsd },
      );
    }
  }

  if (guards.maxPerDay !== undefined) {
    const spent = await store.totalSince(now - DAY_MS);
    if (spent + quoteUsd > guards.maxPerDay) {
      throw new SpendGuardError(
        'maxPerDay',
        `Call costs $${quoteUsd} and $${spent} was already spent today, exceeding the maxPerDay limit of $${guards.maxPerDay}`,
        { limitUsd: guards.maxPerDay, attemptedUsd: spent + quoteUsd },
      );
    }
  }
}

/**
 * Reads the offered requirements from a 402.
 *
 * x402 v2 carries them in the base64 `payment-required` header, not the body — the body
 * is the resource's own, and may be anything. v1 put them in the body, so both are read.
 */
export async function readQuotedRequirements(response: Response): Promise<PaymentRequirements[]> {
  const header = response.headers.get('payment-required');
  if (header) {
    try {
      const decoded = decodePaymentRequiredHeader(header);
      if (Array.isArray(decoded.accepts) && decoded.accepts.length > 0) return decoded.accepts;
    } catch {
      // Fall through to the body form.
    }
  }

  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const accepts = (body as { accepts?: PaymentRequirements[] } | null)?.accepts;
  return Array.isArray(accepts) ? accepts : [];
}

/** Reads the quoted amount out of x402 payment requirements. */
interface PriceableRequirement {
  maxAmountRequired?: string;
  amount?: string;
  asset?: string;
  extra?: { decimals?: number };
}

export function quoteUsdOf(requirements: PaymentRequirements): number {
  const asRecord: PriceableRequirement = requirements;
  const amountAtomic = asRecord.maxAmountRequired ?? asRecord.amount;
  if (!amountAtomic || !asRecord.asset) {
    throw new RangeError('Payment requirements carry no priceable amount; refusing to pay.');
  }
  return quoteToUsd({
    amountAtomic,
    asset: asRecord.asset,
    decimals: asRecord.extra?.decimals,
  });
}

/**
 * Whether an outgoing request already carried a signed payment.
 *
 * Deliberately duck-typed rather than `input instanceof Request`: the x402 fetch wrapper
 * builds the retry request inside its own bundle, and that object fails an `instanceof`
 * check against our realm's `Request` while still carrying the headers. Testing for the
 * shape is what actually holds at runtime.
 */
function carriedPayment(input: RequestInfo | URL, requestInit?: RequestInit): boolean {
  const names = [...PAYMENT_SIGNATURE_HEADERS];
  const fromInit = new Headers(requestInit?.headers ?? {});
  if (names.some((name) => fromInit.has(name))) return true;

  const headers = (input as { headers?: { get?: (name: string) => string | null } } | undefined)
    ?.headers;
  if (typeof headers?.get !== 'function') return false;
  return names.some((name) => headers.get!(name) !== null);
}

/**
 * A `fetch` that pays for 402 responses, under spend guards.
 *
 * The 402 handling, signing and retry are the official x402 packages' work. What this adds
 * is refusal: guards are evaluated inside the payment-policy hook, which runs after the
 * quote is known and before any payload is signed, so exceeding a guard throws
 * SpendGuardError with nothing signed and nothing spent.
 */
export async function payFetch(
  url: RequestInfo | URL,
  init: RequestInit | undefined,
  options: PayFetchOptions,
): Promise<Response> {
  const guards = options.guards ?? {};
  const store = options.store ?? createMemorySpendStore();
  const now = options.now ?? Date.now;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const networks = options.networks ?? (['base'] as NetworkName[]);

  // Host allowlist is checked first: an unauthorised host should cost no request at all.
  if (guards.allowedHosts) {
    const host = hostOf(url);
    if (!host || !hostAllowed(host, guards.allowedHosts)) {
      throw new SpendGuardError(
        'allowedHosts',
        `Host ${host ?? '<unparseable>'} is not in allowedHosts`,
        { host: host ?? undefined },
      );
    }
  }

  let quotedUsd: number | null = null;

  const client = new x402Client((_version, requirements) => {
    // Runs before the payment payload is created. Throwing here means no signature.
    const affordable = requirements.filter((requirement) => {
      const usd = quoteUsdOf(requirement);
      return guards.maxPerCall === undefined || usd <= guards.maxPerCall;
    });

    const chosen = (affordable.length > 0 ? affordable : requirements)[0];
    if (!chosen) throw new RangeError('Resource offered no payment requirements');

    quotedUsd = quoteUsdOf(chosen);
    return chosen;
  });

  for (const name of networks) {
    client.register(NETWORKS[name].caip2, new ExactEvmScheme(options.wallet));
  }

  const guarded: typeof globalThis.fetch = async (input, requestInit) => {
    const response = await baseFetch(input, requestInit);
    if (response.status !== 402) return response;

    // Peek at the quote and apply guards before the wrapper signs anything.
    const accepts = await readQuotedRequirements(response);
    if (accepts.length === 0) {
      if (carriedPayment(input, requestInit)) {
        // We already paid and were still refused: this is a settlement or verification
        // failure at the far end, not a quote we failed to parse. Say so, and do not
        // re-enter the payment path — the signature is already spent.
        throw new PaymentRejectedError(
          `Payment was sent but the server refused it (HTTP ${response.status}). This is a settlement or verification failure, not a quote. Server said: ${
            (await response.clone().text()).slice(0, 300) || '(empty body)'
          }`,
          { status: response.status, body: (await response.clone().text()).slice(0, 300) },
        );
      }
      // A 402 whose requirements we cannot read is a 402 we cannot price, and an
      // unpriced call cannot be checked against a spend cap. Refuse rather than let it
      // through unguarded.
      throw new UnreadableQuoteError(
        'Received a 402 with no readable payment requirements (no payment-required header, no accepts body). Refusing to pay blind.',
      );
    }

    const cheapest = accepts.map((requirement) => quoteUsdOf(requirement)).sort((a, b) => a - b)[0];
    if (cheapest !== undefined) {
      await evaluateGuards(cheapest, guards, store, now());
    }
    return response;
  };

  const paying = wrapFetchWithPayment(guarded, client);
  const response = await paying(url as RequestInfo, init);

  // Record the spend only once a payment actually settled.
  if (readSettlementHeader(response.headers) && quotedUsd !== null) {
    await store.record({ at: now(), usd: quotedUsd });
  }

  return response;
}

export { PAYMENT_REF_HEADER };
