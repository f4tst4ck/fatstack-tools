import { paymentMiddleware } from '@x402/express';
import type { NextFunction, Request, Response } from 'express';

import { PAYMENT_REF_HEADER, SETTLEMENT_HEADERS } from './constants.js';
import type { Paywall } from './provider.js';

export type ExpressMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Express middleware for a paywall. Statically imported so bundlers include it. */
export function expressPaywall(gate: Paywall): ExpressMiddleware {
  const middleware = paymentMiddleware(gate.routeConfig, gate.server);

  return async (req, res, next) => {
    if (gate.killed) {
      res.status(503).json(gate.killswitchBody);
      return;
    }

    // Headers must be attached before the response flushes, so mirror the receipt onto
    // the ref header the moment the adapter sets it.
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = (name: string, value: number | string | readonly string[]) => {
      const out = originalSetHeader(name, value);
      if (SETTLEMENT_HEADERS.includes(name.toLowerCase() as never)) {
        const ref = gate.paymentRef(String(value));
        if (ref) originalSetHeader(PAYMENT_REF_HEADER, ref);
      }
      return out;
    };

    await middleware(req, res, next);
  };
}
