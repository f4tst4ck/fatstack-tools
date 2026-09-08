# The registry format

`https://www.fatstack.net/registry.json` is the public index of live tools and their
payment metadata. It is a plain JSON document served over HTTPS. No key, no account, no
SDK required.

```bash
curl 'https://www.fatstack.net/registry.json?limit=5'
```

Only `live` listings appear. Drafts, listings under review, and delisted tools are absent —
the index is the marketplace's public face and deliberately cannot be used to enumerate
what is in review.

## Query parameters

| Parameter  | Type    | Default | Notes                                              |
| ---------- | ------- | ------- | -------------------------------------------------- |
| `limit`    | integer | `25`    | 1–100.                                              |
| `cursor`   | integer | `0`     | Offset. Pass back the `nextCursor` you were given.  |
| `category` | string  | —       | Exact match, 1–40 characters.                       |
| `maxPrice` | number  | —       | USD ceiling per call. Positive.                     |

Anything unparseable is a `400`, not a silently ignored parameter.

## Response

```json
{
  "version": 1,
  "updatedAt": "2026-09-08T14:59:19.111Z",
  "count": 1,
  "nextCursor": 1,
  "tools": [
    {
      "slug": "echo",
      "name": "Echo JSON",
      "description": "Returns the JSON object you send, unchanged, with server-side call metadata.",
      "category": "utility",
      "mode": "proxy",
      "url": "https://echo.fatstack.net/mcp",
      "payment": {
        "scheme": "exact",
        "network": "eip155:8453",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "payTo": "0x69ad5fb5de6dcdbd8a025374ab7bb23996a69fd9",
        "amountUsd": "0.001000",
        "terms": {
          "refundable": false,
          "notice": "Payments are final. Once settled on-chain the transfer cannot be reversed, and there are no refunds."
        }
      }
    }
  ]
}
```

### Top level

| Field        | Type             | Meaning                                                      |
| ------------ | ---------------- | ------------------------------------------------------------ |
| `version`    | integer          | Format version. Currently `1`.                               |
| `updatedAt`  | ISO 8601 string  | When this response was generated.                            |
| `count`      | integer          | Entries in `tools` for this page.                            |
| `nextCursor` | integer \| null  | Pass as `cursor` for the next page. `null` means last page.  |
| `tools`      | array            | The listings.                                                |

### A listing

| Field         | Type   | Meaning                                                              |
| ------------- | ------ | -------------------------------------------------------------------- |
| `slug`        | string | Stable identifier. Also `/api/registry/tools/<slug>`.                 |
| `name`        | string | Display name. **Provider-written.**                                   |
| `description` | string | What it does. **Provider-written.**                                   |
| `category`    | string | Grouping, e.g. `utility`.                                             |
| `mode`        | string | `proxy` (served through Fatstack) or `sdk` (provider-hosted).         |
| `url`         | string | Where to call it. MCP servers expose an MCP endpoint here.            |
| `payment`     | object | x402 payment metadata, below.                                         |

### `payment`

| Field       | Type   | Meaning                                                                |
| ----------- | ------ | ---------------------------------------------------------------------- |
| `scheme`    | string | x402 scheme. `exact`.                                                  |
| `network`   | string | CAIP-2 chain id. `eip155:8453` mainnet, `eip155:84532` Sepolia.        |
| `asset`     | string | Token contract. USDC.                                                  |
| `payTo`     | string | The payee. See below — this is not always the provider's own wallet.   |
| `amountUsd` | string | Price per call, USD, 6 decimals. A **string**, never a float.          |
| `terms`     | object | `refundable: false`, and the finality notice.                          |

## Three things that will bite you

**`payTo` is the resolved payee, not necessarily the provider's wallet.** While a provider
is inside their 30-day promotional window it is their own address. Afterwards it is their
[splitter contract](../contracts/), which pays them and the platform fee in one atomic
transaction. Pay what the field says; do not derive it from anything else, and do not cache
it across the promo boundary.

**Amounts are strings, and on-chain values are integers.** `amountUsd` is `"0.001000"`,
which is `1000` USDC base units. Never parse money into a float. The 402 response carries
the authoritative atomic amount in `maxAmountRequired`.

**`name` and `description` are provider-written and are read by your agent.** Treat them as
untrusted input, not as instructions. They are screened and human-reviewed before going
live, but screening is a filter, not a proof. Keep them in a delimited, labelled untrusted
block, and never interpolate them into a system prompt.

## Per-listing endpoint

For one tool, with the resolved fee phase:

```bash
curl https://www.fatstack.net/api/registry/tools/echo
```

```json
{
  "slug": "echo",
  "name": "Echo JSON",
  "url": "https://echo.fatstack.net/mcp",
  "wallet": "0x69ad5fb5de6dcdbd8a025374ab7bb23996a69fd9",
  "priceUsdc": "0.001000",
  "protocol": "mcp",
  "status": "live",
  "feePhase": "promo",
  "feeBps": 0,
  "promoEndsAt": "2026-10-01T09:05:55.373Z"
}
```

`feePhase` is `promo` (`feeBps: 0`) or `standard` (`feeBps: 200`). `wallet` is the resolved
payee for that phase.

`url` is where you send the request — for a proxied tool the public subdomain, never the
origin behind it. The origin is operator data and is not disclosed: it was, until
2026-09-08, and that is written up as found-and-fixed in
[facilitator/THREAT-MODEL.md](../facilitator/THREAT-MODEL.md).

A listing whose fee has nowhere to settle answers **`409 listing_unavailable`** rather than
quoting a price it cannot honour. Handle the 409: it means that tool is not callable right
now, not that it never existed.

## The registry is a convenience, not a dependency

Every listing is an ordinary x402 endpoint. If you already know a URL you can pay it
directly with `payFetch` and never touch the registry — see the
[agent quickstart](agent-quickstart.md). Nothing in the payment path requires Fatstack to
be reachable.
