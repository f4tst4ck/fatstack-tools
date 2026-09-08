# @fatstack/x402

Pay-per-call tooling for AI agents. **USDC on Base**, over the
[x402](https://x402.org) protocol.

Two entry points: a **paywall** for providers, and a **spend-guarded fetch** for agents.

Protocol work — signing, verification, settlement — is delegated to the official
`@x402/*` packages. This package adds the parts they leave to you: a provider-shaped
config, a human-readable 402 body, a killswitch, an indexing reference, and spend guards
that refuse a call _before_ anything is signed.

> **Payments are final. There are no refunds.** A payment is a direct on-chain transfer
> between two wallets. Once settled, nobody — including Fatstack — can reverse it.

> **Non-custodial.** Funds move from the agent's wallet to the provider's wallet.
> This package never holds funds and never sees a private key.

## Providers: paywall a route

```ts
import { paywall } from '@fatstack/x402/provider';

const pay = paywall({ price: '0.002', wallet: '0xYourWallet', toolId: 'sentiment' });

app.use('*', pay.hono()); // Hono
app.use(pay.express()); // Express
export const POST = pay.next(handler); // Next.js route handler
```

That is the whole integration. Unpaid requests get a 402 quoting `0.002` USDC payable to
**your** wallet, with the no-refunds notice and a docs link. Paid requests are verified and
settled through the hosted facilitator, then passed through with an
`X-Fatstack-Payment-Ref` header for indexing.

## Agents: pay for a call, under guards

```ts
import { payFetch } from '@fatstack/x402/client';

const res = await payFetch(
  'https://sentiment.fatstack.net/run',
  { method: 'POST' },
  {
    wallet: account, // any viem account; we never see your key
    guards: {
      maxPerCall: 0.01,
      maxPerHour: 1,
      maxPerDay: 10, // USD
      allowedHosts: ['fatstack.net'],
    },
  },
);
```

Exceeding any guard throws `SpendGuardError` **before a payment is signed**. Because
payments are irreversible, the guard is the last point at which a spend can be stopped —
so it runs on the quote, not after the fact.

## Guards

| Guard          | Enforced                                                          |
| -------------- | ----------------------------------------------------------------- |
| `allowedHosts` | Before any network call. A subdomain of a listed host is allowed. |
| `maxPerCall`   | On the quoted price, before signing.                              |
| `maxPerHour`   | Rolling 60 minutes, quote + prior spend, before signing.          |
| `maxPerDay`    | Rolling 24 hours, quote + prior spend, before signing.            |

Counters live in a `SpendStore`. The default is in-memory and **per process** — an agent
running as several processes enforces a separate budget in each. Pass your own store
(Redis, a Durable Object, Postgres) to share one budget:

```ts
import { createMemorySpendStore, type SpendStore } from '@fatstack/x402';
```

A quote in an asset the package cannot price fails closed: it throws rather than guess
decimals, because guessing could let an unknown token slip past a cap.

## Environment

| Variable              | Meaning                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `FACILITATOR_URL`     | Hosted facilitator. Defaults to `https://x402.org/facilitator`.                                                             |
| `FACILITATOR_API_KEY` | Sent as a bearer token to the facilitator, if set.                                                                          |
| `KILLSWITCH`          | `1` takes every paywalled route offline with a 503, taking no payment.                                                      |
| `FEE_MODE`            | `direct` (default) pays the provider wallet with a 0% fee. `splitter` throws — there is no splitter contract in this build. |

## Framework adapters

`@x402/hono`, `@x402/express` and `@x402/next` are **optional peer dependencies**, loaded
only when you call that adapter. Install the one you use:

```bash
pnpm add @fatstack/x402 @x402/hono
```

`pay.next()` requires `@x402/next`, which needs **Next.js ≥ 16.2.6** (upstream peer
requirement). The Hono and Express adapters have no such constraint.

## Testing your integration

```ts
import { createMockFacilitator } from '@fatstack/x402/testing';

const pay = paywall({ ...config, facilitator: createMockFacilitator() });
// or: createMockFacilitator({ invalidReason: 'insufficient_funds' })
```

Nothing in the mock touches a chain or a network.

## Local development

```bash
pnpm --filter @fatstack/x402 build      # tsup -> dist (ESM + CJS + d.ts)
pnpm --filter @fatstack/x402 test
pnpm --filter @fatstack/x402 typecheck
```
