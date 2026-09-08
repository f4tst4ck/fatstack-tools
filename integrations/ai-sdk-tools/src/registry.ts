import { z } from 'zod';

/**
 * Reading the Fatstack catalogue.
 *
 * The registry is a plain public JSON document — no key, no account — so discovery costs
 * nothing and an agent can decide what it is willing to pay for before it pays for
 * anything. Everything here is parsed rather than trusted: the catalogue describes
 * third-party tools, and a listing is untrusted input even when we serve it.
 */
export const DEFAULT_REGISTRY_URL = 'https://www.fatstack.net/registry.json';

const paymentSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  payTo: z.string(),
  amountUsd: z.string(),
});

const listingSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string().optional(),
  mode: z.string().optional(),
  url: z.string().url(),
  payment: paymentSchema,
});

const registrySchema = z.object({ tools: z.array(listingSchema) });

export type FatstackListing = z.infer<typeof listingSchema>;

export interface FetchListingsOptions {
  registryUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** CAIP-2 chain id, e.g. `eip155:8453`. Listings on other chains are ignored. */
  network?: string;
  /** Skip anything dearer than this, in USD. Applied before the agent ever sees it. */
  maxPriceUsd?: number;
  /** Restrict to these slugs. */
  only?: string[];
}

/** Fetches and filters the catalogue. Throws on an unreadable registry rather than guessing. */
export async function fetchListings(
  options: FetchListingsOptions = {},
): Promise<FatstackListing[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = options.registryUrl ?? DEFAULT_REGISTRY_URL;

  const response = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Fatstack registry returned ${response.status} for ${url}`);
  }

  const parsed = registrySchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `Fatstack registry did not match the expected shape: ${parsed.error.issues[0]?.message}`,
    );
  }

  return parsed.data.tools.filter((listing) => {
    if (options.network && listing.payment.network !== options.network) return false;
    if (options.only && !options.only.includes(listing.slug)) return false;
    if (
      options.maxPriceUsd !== undefined &&
      Number(listing.payment.amountUsd) > options.maxPriceUsd
    ) {
      return false;
    }
    return true;
  });
}

/** A tool name the AI SDK will accept: letters, digits and underscores. */
export function toolNameFor(listing: Pick<FatstackListing, 'slug'>): string {
  return listing.slug.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'fatstack_tool';
}
