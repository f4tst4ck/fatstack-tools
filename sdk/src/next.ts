import { withX402 } from '@x402/next';
import type { NextRequest, NextResponse } from 'next/server';

import { PAYMENT_REF_HEADER, readSettlementHeader } from './constants.js';
import type { Paywall } from './provider.js';

/**
 * Wraps a Next.js route handler with a paywall. Requires `@x402/next`, which upstream
 * needs Next >= 16.2.6. Statically imported so bundlers include it — which is also why
 * this lives in its own entry point and never reaches a Worker bundle.
 */
export function nextPaywall<T>(
  gate: Paywall,
  handler: (request: NextRequest) => Promise<NextResponse<T>>,
): (request: NextRequest) => Promise<NextResponse<T>> {
  const wrapped = withX402(handler, gate.routeConfig, gate.server);

  return async (request: NextRequest): Promise<NextResponse<T>> => {
    const result = await wrapped(request);

    const ref = gate.paymentRef(readSettlementHeader(result.headers));
    if (ref) result.headers.set(PAYMENT_REF_HEADER, ref);
    return result;
  };
}
