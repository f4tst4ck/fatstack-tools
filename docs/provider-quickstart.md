# Provider quickstart

Put a per-call price on an HTTP route or an MCP server, get paid in USDC on Base, and keep
the money in your own wallet the whole time.

## Before you start

You need a wallet address to be paid at. That is the entire onboarding requirement — there
is no account, no password, and no key you hand over. Fatstack never holds your funds and
cannot move them.

Test on **Base Sepolia** first. The money on Base mainnet is real and payments are final.

## 1. Paywall a route

```bash
npm install @fatstack/x402
```

```ts
import { Hono } from 'hono';
import { paywall } from '@fatstack/x402';
import { honoPaywall } from '@fatstack/x402/hono';

const app = new Hono();

app.use(
  '/convert',
  honoPaywall(
    paywall({
      price: '0.001',            // USDC per call, at most 6 decimals
      wallet: '0xYourWallet',    // where the money lands
      toolId: 'unit-convert',    // your identifier for this listing
      network: 'base-sepolia',
    }),
  ),
);

app.post('/convert', (c) => c.json({ celsius: 20, fahrenheit: 68 }));
```

Express and Next work the same way, from `@fatstack/x402/express` and
`@fatstack/x402/next`. The adapters live on separate entry points so importing one does
not pull the others' framework types in with it.

## 2. What your callers now see

An unpaid call gets `402 Payment Required` with the price, the asset, the address to pay,
and the resource the quote is for:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0xYourWallet",
      "maxAmountRequired": "1000",
      "resource": "https://your-host/convert"
    }
  ],
  "terms": {
    "refundable": false,
    "notice": "Payments are final. Once settled on-chain the transfer cannot be reversed, and there are no refunds."
  }
}
```

The caller signs an EIP-3009 authorisation and retries with an `X-PAYMENT` header. Your
handler runs, then settlement is broadcast. You never see a private key and never pay gas.

**`resource` is not decoration.** An EIP-3009 signature covers the payment fields and not
what was bought, so the middleware checks that the authorisation in hand was quoted for the
route in hand and rejects a mismatch with `resource_mismatch`. This is the fix for a real
vulnerability — see the security section of the [main README](../README.md).

## 3. Test it end to end

Point at Base Sepolia, fund a test wallet from a faucet, and call your own route with the
agent client:

```ts
import { payFetch } from '@fatstack/x402/client';
import { privateKeyToAccount } from 'viem/accounts';

const res = await payFetch(
  'http://localhost:3000/convert',
  { method: 'POST' },
  {
    wallet: privateKeyToAccount(process.env.TEST_KEY),
    networks: ['base-sepolia'],
    guards: { maxPerCall: 0.01 },
  },
);
console.log(res.status, await res.json());
```

`payFetch` is a `fetch` that handles the 402 for you: it reads the quote, checks it against
your guards, signs, and retries. A guard that would be exceeded throws `SpendGuardError`
with nothing signed and nothing spent.

A settled call takes about a second. If it hangs, the facilitator is the thing to check
first.

## 4. List it on the marketplace

Listing is optional — the middleware works standalone, and you can sell to agents that
already know your URL. Listing puts you in the registry that agents discover through.

Go to [fatstack.net](https://www.fatstack.net), sign in with your wallet, and submit the
tool. **Every listing is reviewed by a human before it goes live.** There is no
auto-approval, including for high-reputation providers, because listing text is read by
other people's agents and is therefore an injection surface, not just a display surface.

## Fees

**0% for your first 30 days**, from the day you register. After that a flat **2%**, with no
minimum, computed as `floor(gross × 2%)` in USDC base units — the remainder goes to you.
Rounding is always down, so the platform can never take more than 2%.

During the promotional period the agent pays your wallet directly. Afterwards, payment goes
through an immutable [splitter contract](../contracts/) that pays you and the platform fee
in one atomic transaction. There is no version of this where Fatstack holds your revenue,
even for a single call frame.

## Things worth knowing

- **Payments are final.** No refunds, no chargebacks, no escrow. Price accordingly, and
  make failures cheap — a handler that errors after settlement has still been paid for.
- **Your handler runs before settlement is confirmed.** That window is documented in
  [facilitator/THREAT-MODEL.md](../facilitator/THREAT-MODEL.md). For expensive work,
  consider what you are willing to do on a verified-but-unsettled payment.
- **The killswitch is yours.** `KILLSWITCH=1` takes every paywalled route offline with a
  503 and takes no payment.
- **Prices are USDC with at most 6 decimals**, and the marketplace enforces a $0.0001 floor
  to keep dust listings out.
