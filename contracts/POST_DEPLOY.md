# After deploying the splitter

What to do once the factory exists on a chain, and how to verify it is the contract you
think it is.

---

## Deployed

| Network      | Factory                                          | Provider splitter                            | Treasury                                     |
| ------------ | ------------------------------------------------ | -------------------------------------------- | -------------------------------------------- |
| Base Sepolia | `0x165856f0b95F2B9Bea7405139c2277B9D01928F4`     | `0xDfE85CEe968de2629b4444E6E4E19C289B123d92` | `0xF63a95110F158533C19268Cc6501eBaA8C9DDDF5` |
| Base mainnet | **not deployed — see [go/no-go](./GO-NO-GO.md)** | —                                            | —                                            |

Sepolia has been exercised with a real signed EIP-3009 payment:
`0xd44794813cc9abd4e150a70198e1c0e5e7dd07e11554fd09df227cdeda7b6750` — 1000 base units in,
980 to the provider, 20 to the treasury, `Payment` emitted with the listing's `toolId`.

---

## 1. Verify the source on Basescan

```bash
forge verify-contract <FACTORY_ADDRESS> src/FatstackSplitterFactory.sol:FatstackSplitterFactory \
  --chain base-sepolia \
  --constructor-args $(cast abi-encode "constructor(address,address)" <USDC> <TREASURY>) \
  --etherscan-api-key $BASESCAN_API_KEY

forge verify-contract <SPLITTER_ADDRESS> src/FatstackSplitter.sol:FatstackSplitter \
  --chain base-sepolia \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" <USDC> <PROVIDER> <TREASURY>) \
  --etherscan-api-key $BASESCAN_API_KEY
```

Verification matters more here than usual: the contract is immutable and has no owner, so
the published source is the only thing a provider can inspect to satisfy themselves that
the address in their 402 will actually pay them.

## 2. Read the deployed values back off the chain

Do not trust the deploy log. Read the contract.

```bash
cast call <SPLITTER> "PROVIDER()(address)" --rpc-url $RPC
cast call <SPLITTER> "TREASURY()(address)" --rpc-url $RPC
cast call <SPLITTER> "USDC()(address)"     --rpc-url $RPC
cast call <SPLITTER> "FEE_BPS()(uint256)"  --rpc-url $RPC
```

All four are immutable. If any is wrong the contract cannot be corrected — deploy a new
one and point the registry at it.

## 3. Check the split arithmetic on the deployed contract

```bash
cast call <SPLITTER> "feeFor(uint256)(uint256)" 149     --rpc-url $RPC   # 2, not 3
cast call <SPLITTER> "feeFor(uint256)(uint256)" 49      --rpc-url $RPC   # 0
cast call <SPLITTER> "feeFor(uint256)(uint256)" 1000000 --rpc-url $RPC   # 20000
```

These are three of the vectors in `test/vectors.json`, which the TypeScript SDK asserts
against the same values. Matching here means the on-chain split and the price we quote
cannot disagree.

## 4. Point the platform at it

```bash
# set wherever the registry and the indexer read their environment
SPLITTER_FACTORY_ADDRESS=<FACTORY_ADDRESS>
```

The registry resolves each provider's splitter from the factory and only quotes it once
`isDeployed` is true. An address with no code would take a payment that settles into
nothing.

## 5. Deploy a splitter for each provider leaving their promo

```bash
cast send <FACTORY> "deploy(address)" <PROVIDER_WALLET> --rpc-url $RPC --private-key $KEY
```

Permissionless — anyone may call it, and the result can only ever pay that provider. The
address is derivable in advance:

```bash
cast call <FACTORY> "splitterFor(address)(address)" <PROVIDER_WALLET> --rpc-url $RPC
```

## 6. Watch the first real payment

The indexer records splitter `Payment` events alongside direct transfers. After the first
post-promo payment, confirm:

- the `payments` row exists, confirmed, credited to the right listing
- the provider received 98% and the treasury 2%, read from the chain
- the catalog figure moved by the gross amount

`pnpm canary` does all three. Do not rely on the deploy having "worked" until it has.

---

## If something is wrong

There is no pause and no upgrade. The remedies are:

1. **Unset `SPLITTER_FACTORY_ADDRESS`.** Every post-promo listing immediately fails
   activation and the registry answers 409 instead of quoting a bad payee. Promo-phase
   listings are unaffected — they pay providers directly and never touch the contract.
2. **Deploy a corrected factory** and point the platform at the new address. Splitters
   already deployed by the old factory keep working; they are independent contracts.

Neither recovers a payment already settled. Payments are final, which is why steps 2 and 3
above are read off the chain rather than taken from a log.
