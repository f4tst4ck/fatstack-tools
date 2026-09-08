import { paymentMiddleware } from '@x402/hono';
import type { MiddlewareHandler } from 'hono';

import {
  PAYMENT_REF_HEADER,
  PAYMENT_SIGNATURE_HEADERS,
  readSettlementHeader,
} from './constants.js';
import type { Paywall } from './provider.js';
import { checkResourceBinding, resourceMismatchBody } from './resource-binding.js';

/**
 * Hono middleware for a paywall.
 *
 * `@x402/hono` is imported statically so bundlers include it — a dynamic import here is
 * invisible to esbuild and the adapter goes missing at runtime.
 */
export function honoPaywall(gate: Paywall): MiddlewareHandler {
  const middleware = paymentMiddleware(gate.routeConfig, gate.server);

  return async (c, next) => {
    if (gate.killed) return c.json(gate.killswitchBody, 503);

    /*
     * Bind the authorisation to this exact resource, before anything else touches it.
     *
     * An EIP-3009 signature covers the transfer, not what was bought, so two sibling tools
     * at the same price quote identical requirements and an authorisation for one settles
     * happily at the other. Checked here rather than at the facilitator because the
     * requirements forwarded there carry no resource to compare against — only this layer
     * knows the URL that was actually called.
     *
     * Rejecting before `middleware` also means a mismatched payment costs no facilitator
     * round trip and, critically, is never settled: the payer keeps their money instead of
     * paying for a resource they did not ask for.
     */
    const header =
      PAYMENT_SIGNATURE_HEADERS.map((name) => c.req.header(name)).find(Boolean) ?? null;
    const binding = checkResourceBinding(header, c.req.url);
    if (!binding.ok) return c.json(resourceMismatchBody(binding), 402);

    const result = await middleware(c, next);

    // c.res carries what Hono will send, whether the middleware set it or the handler did.
    const carrier = result instanceof Response ? result : c.res;
    const ref = carrier ? gate.paymentRef(readSettlementHeader(carrier.headers)) : null;
    if (ref) carrier.headers.set(PAYMENT_REF_HEADER, ref);
    return result;
  };
}
