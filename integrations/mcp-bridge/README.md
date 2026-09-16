# @fatstack/mcp-bridge

A stdio MCP server that relays to the hosted [Fatstack](https://www.fatstack.net) catalogue,
where agents discover tools and pay per call in USDC via x402 on Base.

The catalogue is served at `https://www.fatstack.net/api/mcp` over streamable HTTP. If your
client speaks that, point it there directly — you do not need this package. This exists for
clients that only speak stdio.

## Use it

```bash
npx @fatstack/mcp-bridge
```

In a client config:

```json
{
  "mcpServers": {
    "fatstack": {
      "command": "npx",
      "args": ["-y", "@fatstack/mcp-bridge"]
    }
  }
}
```

That gives you **discovery**: the catalogue, every tool, and what each one charges. Listing is
free. Calling a paid tool returns that provider's own 402 quote, telling you the price, the
asset and the payee.

## Paying

To let the bridge complete paid calls, give it a wallet and a ceiling:

```json
{
  "mcpServers": {
    "fatstack": {
      "command": "npx",
      "args": ["-y", "@fatstack/mcp-bridge"],
      "env": {
        "FATSTACK_AGENT_KEY": "0x...",
        "FATSTACK_MAX_PER_DAY": "0.50",
        "FATSTACK_MAX_PER_CALL": "0.01"
      }
    }
  }
}
```

`FATSTACK_MAX_PER_DAY` is **required** whenever a key is present. The process refuses to start
without it, rather than defaulting to a number we chose for your money.

**Payments are final. There are no refunds and no chargebacks.** Fund a throwaway wallet with
what you are willing to lose in a day, and no more.

| Variable                | Required   | Default                            | Meaning                                 |
| ----------------------- | ---------- | ---------------------------------- | --------------------------------------- |
| `FATSTACK_MCP_URL`      | no         | `https://www.fatstack.net/api/mcp` | catalogue to relay to                   |
| `FATSTACK_AGENT_KEY`    | no         | —                                  | private key; omit for discovery only    |
| `FATSTACK_MAX_PER_DAY`  | with a key | —                                  | hard USD ceiling per UTC day            |
| `FATSTACK_MAX_PER_CALL` | no         | —                                  | refuse any single call dearer than this |
| `FATSTACK_NETWORK`      | no         | `base`                             | `base` or `base-sepolia`                |

## What it does and does not do

It is a relay. It never mints a quote, never rewrites a price, and never becomes a payee —
the same rule the hosted aggregator holds to. Payment goes wallet to wallet, from you to the
provider.

Your key is read from the environment of the process you started, on your machine. It is
never transmitted to Fatstack, and nothing here writes it anywhere.

An unreachable catalogue is reported as an error, never as an empty tool list. Those two
look identical to a client that cannot tell them apart, and only one is worth retrying.

## Licence

MIT.
