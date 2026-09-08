# contracts

The USDC payment splitter. One contract per provider, deployed by a CREATE2 factory.

| File                              | What it is                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `src/FatstackSplitter.sol`        | Splits one payment: `floor(2%)` to the treasury, the rest to one provider    |
| `src/FatstackSplitterFactory.sol` | Deploys one splitter per provider at a derivable address                     |
| `SECURITY.md`                     | Threat model, slither findings, and the vulnerability that shaped the design |
| `GO-NO-GO.md`                     | **Read before any mainnet deploy.** The founder deploys mainnet by hand      |
| `POST_DEPLOY.md`                  | Verification steps and what to do if something is wrong                      |
| `test/vectors.json`               | Fee pairs asserted by both the contract and the TypeScript SDK               |

```bash
forge test                                    # 31 tests
BASE_RPC_URL=... forge test --match-contract Fork -vv   # against real USDC
```

## The one thing to understand

**The provider is fixed at construction and is never a call parameter.**

An EIP-3009 signature covers `(from, to, value, validAfter, validBefore, nonce)`. A
`provider` argument would not be covered by it, so anyone who observed a payment
authorisation could submit it themselves with their own address and take the provider's
98%. `receiveWithAuthorization` stops a third party front-running the _transfer_; it does
nothing about a recipient contract that lets its caller choose where the money goes next.

Hence one splitter per provider. Whoever submits the transaction, the funds can only reach
that provider.

## Deployed

- **Base Sepolia** — factory `0x165856f0b95F2B9Bea7405139c2277B9D01928F4`, exercised with
  a real signed payment splitting 980/20.
- **Base mainnet** — not deployed. See `GO-NO-GO.md`.
