/**
 * Binding a payment to the thing it paid for.
 *
 * An EIP-3009 authorisation signs `(from, to, value, validAfter, validBefore, nonce)` and
 * nothing else. It does not sign *what was bought*. Two tools from one provider at one
 * price therefore quote byte-identical payment requirements, so an authorisation minted
 * for tool A satisfies tool B's requirements exactly — verified live on Base Sepolia on
 * 2026-09-03, where a fresh authorisation for `adversarial-tool-a` was accepted, settled
 * and served by `adversarial-tool-b`.
 *
 * The x402 payload already carries a `resource` naming what the payer believed they were
 * buying, and the payer's client fills it in from the 402 it just received. Nothing
 * checked it. The requirements our resource server forwards to the facilitator do not even
 * include a resource, so the facilitator *cannot* check it — the comparison has to happen
 * where the real request URL is known, which is here.
 *
 * This changes nothing about what a 402 quotes. It starts enforcing a field that was
 * always quoted, always signed into the payload by the client, and always ignored.
 */

/** Origin plus path, lowercased host, no query or fragment. */
function canonical(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

export interface BindingCheck {
  ok: boolean;
  /** Present on failure, safe to log. Never echoes the payer's signature. */
  reason?: string;
  claimed?: string | undefined;
  expected?: string | undefined;
}

/**
 * Reads the resource a payment header claims, without trusting any of it.
 *
 * A header we cannot decode is not a binding failure — it is a malformed payment, and the
 * normal verification path is what should reject it with the right error. Returning `ok`
 * here defers to that rather than inventing a second rejection reason for the same fault.
 */
export function checkResourceBinding(headerValue: string | null, requestUrl: string): BindingCheck {
  if (!headerValue) return { ok: true };

  let claimedUrl: string | undefined;
  try {
    const decoded: unknown = JSON.parse(
      typeof atob === 'function'
        ? atob(headerValue)
        : Buffer.from(headerValue, 'base64').toString('utf8'),
    );
    const resource = (decoded as { resource?: { url?: unknown } } | null)?.resource;
    if (typeof resource?.url === 'string') claimedUrl = resource.url;
  } catch {
    return { ok: true };
  }

  // A payload with no resource at all cannot be bound. Older clients may omit it, and
  // rejecting them here would break payers who are not attacking anything — the amount,
  // payee, asset and network checks still apply to them.
  if (!claimedUrl) return { ok: true };

  const claimed = canonical(claimedUrl);
  const expected = canonical(requestUrl);
  if (!claimed || !expected) return { ok: true };

  if (claimed !== expected) {
    return {
      ok: false,
      reason: 'resource_mismatch',
      claimed,
      expected,
    };
  }
  return { ok: true };
}

/** The 402 body returned when a payment was minted for a different resource. */
export function resourceMismatchBody(check: BindingCheck): Record<string, unknown> {
  return {
    error: 'payment_required',
    reason: 'resource_mismatch',
    message:
      'This payment authorisation names a different resource than the one you called. An ' +
      'authorisation is valid only for the exact URL it was quoted for. Request a fresh ' +
      'quote from this endpoint and pay that. No payment was taken and nothing was settled.',
    claimedResource: check.claimed,
    thisResource: check.expected,
  };
}
