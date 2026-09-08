# Agent quickstart

Give an agent a wallet and a spending limit, and let it discover and pay for tools on its
own. Discovery is free. Only calls cost money.

## Before you start

You need a funded wallet. On **Base Sepolia** that means testnet USDC from a faucet, plus
nothing else — the agent signs authorisations and never pays gas, so it needs no ETH.

Start on Sepolia. On Base mainnet the USDC is real and **payments are final: there are no
refunds and no chargebacks.** An agent with a key and no cap can spend everything in the
wallet.

## Option A — a tool set for the Vercel AI SDK

```bash
npm install @fatstack/ai-sdk-tools ai viem
```

```ts
import { generateText } from 'ai';
import { fatstackTools } from '@fatstack/ai-sdk-tools';
import { privateKeyToAccount } from 'viem/accounts';

const tools = await fatstackTools({
  wallet: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  networks: ['base-sepolia'],
  guards: {
    maxPerDay: 0.5,     // hard USD ceiling per UTC day
    maxPerCall: 0.01,   // refuse any single call dearer than this
  },
});

const { text } = await generateText({
  model,
  tools,
  prompt: 'Convert 20 degrees Celsius to Fahrenheit.',
});
```

Each catalogue listing becomes one tool. The model picks; the tool pays; the result comes
back. Discovery happens once, up front, and costs nothing.

### `guards` is required, deliberately

It is a required argument with no default, so a tool set that can spend money cannot be
constructed by forgetting something. Omit it and you get `MissingSpendGuardError` on the
line that forgot it — before the catalogue is even fetched, so a missing cap never
masquerades as a network problem.

## Option B — pay for any 402 endpoint directly

You do not need the marketplace. `payFetch` is a `fetch` that handles a 402 wherever it
finds one.

```ts
import { payFetch } from '@fatstack/x402/client';
import { privateKeyToAccount } from 'viem/accounts';

const res = await payFetch(
  'https://echo.fatstack.net/mcp',
  { method: 'POST', body: JSON.stringify({ hello: 'world' }) },
  {
    wallet: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
    networks: ['base'],
    guards: {
      maxPerCall: 0.01,
      maxPerHour: 0.10,
      maxPerDay: 1.00,
      allowedHosts: ['echo.fatstack.net'],
    },
  },
);
```

Guards are evaluated **after the quote is known and before anything is signed**, so
exceeding one throws `SpendGuardError` with nothing signed and nothing spent.
`allowedHosts` is checked first of all, before any network request — an unauthorised host
costs you not even a round trip.

Spend is tracked in a process-local in-memory store by default. Pass your own `store` to
make limits survive a restart or apply across processes; without that, restarting the agent
resets its daily ceiling.

## Discovering what is available

The catalogue is a plain JSON document. No key, no account:

```bash
curl 'https://www.fatstack.net/registry.json?limit=5'
```

Each entry carries the invocation URL and the payment metadata — network, asset, payee,
price. Format details: **[registry-format.md](registry-format.md)**.

## What a paid call actually does

1. Your request arrives without payment; the tool answers **402** with a quote.
2. The client reads the quote and checks it against your guards.
3. It signs an **EIP-3009 authorisation** — a message, not a transaction. No gas.
4. It retries with an `X-PAYMENT` header.
5. The provider verifies, runs the handler, and settles. USDC moves wallet to wallet.

Roughly a second end to end. Your wallet's USDC balance falls by exactly the quoted amount.

## Treat listing text as untrusted

Names, descriptions and parameter documentation are written by providers, and your agent
reads them. **They are an injection surface.** Every listing is screened and human-reviewed
before going live, but screening is a filter, not a proof.

Never interpolate listing text into a system prompt. When you show it to a model, keep it
inside a clearly delimited, labelled untrusted block. Spend guards are the backstop that
holds even if a description does convince your agent to call something it should not.

## Failure modes worth handling

| What you see            | What it means                                                        |
| ----------------------- | -------------------------------------------------------------------- |
| `SpendGuardError`       | A cap would have been exceeded. Nothing signed, nothing spent.        |
| `resource_mismatch`     | The payment was quoted for a different resource. Re-read the 402.     |
| `402` on a retry        | The payment was rejected. The reason is in the body.                  |
| A slow first call       | Settlement takes about a second. Budget for it in timeouts.           |

**Payments are final.** A handler that fails after settlement has still been paid for.
Cap what you are willing to lose, rather than planning to recover it.
