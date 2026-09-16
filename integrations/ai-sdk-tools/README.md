# @fatstack/ai-sdk-tools

AI SDK tools that discover [Fatstack](https://www.fatstack.net) listings and pay per call in
USDC via [x402](https://x402.org) on Base.

Discovery is free. Calling a tool issues a payment from your wallet, wallet to wallet — the
platform is never a payee and never holds funds.

```bash
npm install @fatstack/ai-sdk-tools ai viem @ai-sdk/openai
```

## Usage

```ts
import { fatstackTools } from '@fatstack/ai-sdk-tools';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { privateKeyToAccount } from 'viem/accounts';

const tools = await fatstackTools({
  wallet: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  guards: { maxPerDay: 1.0, maxPerCall: 0.01 },
});

const result = await generateText({
  model: openai('gpt-5'),
  tools,
  prompt: 'Convert 20 degrees Celsius to Fahrenheit.',
});
```

## Spend guards are required

`guards.maxPerDay` is not optional and has no default. The constructor throws without it,
before any network call.

That is deliberate. These tools hand an autonomous agent a wallet and a catalogue, and the
failure mode is not a bad answer — it is a drained wallet, discovered later. A default would
be a number we chose for your money, and an optional cap would be missing exactly when a
loop goes wrong.

`maxPerDay` specifically, rather than only a per-call limit: a per-call cap does nothing
against a thousand cheap calls, which is the shape a runaway agent actually has.

```ts
// Throws MissingSpendGuardError
await fatstackTools({ wallet });

// Also throws — maxPerDay is the one that binds
await fatstackTools({ wallet, guards: { maxPerCall: 0.01 } });
```

The caps are closed over when the tools are built, so the model cannot raise its own limit.

## Filtering the catalogue

```ts
const tools = await fatstackTools({
  wallet,
  guards: { maxPerDay: 1.0 },
  network: 'eip155:8453', // only listings on this chain
  maxPriceUsd: 0.01, // never even offer the model anything dearer
  only: ['unit-convert'], // or pick specific slugs
});
```

Price filtering happens before the model sees a tool, so it cannot choose to overspend on
something you never intended to offer.

## Running the example

The example runs against **Base mainnet** and spends real USDC. That is not a choice — it is
what the public catalogue serves: every live listing settles on `eip155:8453`, so a Sepolia
configuration discovers nothing and can never complete a call. `fatstackTools` now refuses that
combination outright rather than building tools it will decline to pay for.

**Your wallet needs USDC on Base and no ETH.** x402 payments are signed off-chain and settled by
the facilitator, so the agent never pays gas.

1. Generate a throwaway wallet and fund it with a small amount of USDC on Base. A dollar covers
   hundreds of calls at typical listing prices.
2. Set the spend guards. `maxPerDay` is required and has no default; `maxPerCall` bounds a single
   call. They are evaluated after the quote is known and before anything is signed, so exceeding
   one costs nothing.
3. Fund only what you are willing to lose in a day. Payments are final and there are no refunds.

**Testing against a testnet** requires a catalogue that serves one. Point `registryUrl` at it;
the public catalogue is mainnet-only.

## Payments are final

Every call spends real USDC and settles on chain. There are no refunds, and there is no
mechanism by which Fatstack could issue one — payments go straight from your wallet to the
provider's. The price is in each tool's description before the model calls it.

## Licence

MIT
