# Mainnet go/no-go — FatstackSplitter

**Nothing here has been deployed to mainnet, and nothing will be by me.** This is the
checklist for the person who reads the contract line by line and deploys it themselves.

Everything is ready: the contracts are written, **34 tests pass — but only with
`BASE_RPC_URL` set**, and four of them are the Base fork test against real mainnet USDC;
slither reports five informational findings, each justified in `SECURITY.md`; and the whole
path has been exercised on Base Sepolia with a real signed payment.

Note the RPC condition. Until 2026-09-08 those four tests `return`ed silently when the
variable was unset and were counted as passing, so this document claimed a fork test
against real USDC that had not run. They now `vm.skip`, and the summary says
`30 passed, 4 skipped`. Since 2026-09-08 **CI runs `forge test` on every push and pull
request**, with a Base mainnet RPC for the fork suite and a guard that fails the build if
the skipped count is anything but zero — or if it cannot read the summary at all. The
evidence below still carries a date, because a green CI proves the suite ran, not that the
deployed contract still agrees with it. What follows is what you should
satisfy yourself of before repeating that on a chain where the money is real.

---

## Read these three things first

1. **`src/FatstackSplitter.sol`** — 160 lines, most of it comments. The part that moves
   money is about fifteen lines.
2. **`SECURITY.md`** — in particular _The finding that changed the design_. An earlier
   draft would have let a bystander steal payments; understanding why tells you what the
   contract is actually protecting against.
3. **`test/vectors.json`** — the twelve fee pairs that both the contract and the SDK are
   asserted against.

---

## Blocking checks

Each of these is a stop. None is a formality.

### 1. The money can only go two places

- [ ] `PROVIDER` and `TREASURY` are immutable and set in the constructor.
- [ ] `payWithAuthorization` takes **no** provider argument. Confirm by reading the
      signature: `payWithAuthorization(bytes32,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`.
      _This is the whole security model._ An EIP-3009 signature does not cover such an
      argument, so if one existed, anyone who saw a payment authorisation could redirect
      it to themselves.
- [ ] There is no `withdraw`, no `sweep`, no `owner`, no `pause`, no proxy, no
      `selfdestruct`, and no `delegatecall`. Search for each.

### 2. The arithmetic

- [ ] `feeFor` is `(amount * 200) / 10_000` — integer division, so it floors.
- [ ] The remainder goes to the provider: `received - fee`.
- [ ] `forge test` passes, including `testFuzz_splitIsExactAndNeverRoundsUp`.
- [ ] You accept that a payment below 50 base units yields **no fee at all**. That is the
      flat-2%-no-minimum rule working as specified.

### 3. The addresses you are about to bake in permanently

- [ ] `USDC_ADDRESS` is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — Base **mainnet**
      USDC. Check it character by character against a source you trust, not against this
      file.
- [x] `TREASURY_ADDRESS` is **`0x07cA3A6BA32ecB2CF209d9Fb1e2fE8074D4e9946`** — final, fixed 2026-09-08.
      Verified: EIP-55 checksum valid exactly as written; a **Safe v1.4.1** multisig on Base
      mainnet (singleton `0x29fcB43b…C762`). Its owner set and threshold are readable on
      chain and are not restated here. It is distinct from every operational wallet — the
      provider payout address and the facilitator's gas signer among them.
      A Safe is the right shape here precisely because the splitter's treasury is immutable:
      the signing key can be rotated later without redeploying the contract.
- [x] You have sent a test transaction to the treasury address on mainnet and it arrived.
      1.000000 USDC from the Safe's own owner at 2026-09-08T14:03:05Z, tx
      `0xf5b02b38c986fa4e3d9087c8a6731aa868ebfb2bc7e5de871b285927ffae490d`. Confirmed by
      reading USDC `Transfer` logs into the address, not by a balance poll.

### 4. The deployer

Either of two shapes is acceptable. Both end with a key that cannot sign anything of
value afterwards, which is the property that matters — not the hardware.

**A. Hardware wallet.** `--ledger`, `--trezor`, or `--interactive`. The key never exists
on the machine.

**B. A freshly-generated single-purpose software EOA.** Legitimate, and often the more
honest choice than reusing a long-lived key. All of the following, not a subset:

- [ ] **Generated immediately before the deploy**, for this deploy only. Never used for
      anything else, never reused afterwards.
- [ ] **Funded with gas only** — roughly 0.001 Base ETH. It never holds USDC and is never
      the treasury, the provider payout wallet, or a facilitator signer.
- [ ] **Key supplied via the environment for the session**, never on the command line —
      argv is visible to other processes and lands in shell history.
      `script/Deploy.s.sol` reads `DEPLOYER_PRIVATE_KEY`.
- [ ] **Drained and retired after the post-deploy checks pass.** Remaining ETH swept out,
      the key deleted, the address never used again.

The deployer has no lasting authority in either shape: the factory has no owner, so once
deployed, the deploying key controls nothing. Its only power is the window between
generating it and retiring it — which is why B is bounded by generating it late and
draining it early, rather than by where it is stored.

- [ ] Whichever shape: the key is **not** passed on the command line.
- [ ] It holds enough Base ETH for the deploy — roughly 0.001 ETH is ample.

### 5. Prove it on testnet one more time, the day of

Run the suite with the fork RPC set, or four of the tests will skip:
`BASE_RPC_URL=https://mainnet.base.org forge test`. Verified 2026-09-08 at `4c47151`:
34 passed, 0 failed, 0 skipped.

- [ ] The daily splitter canary is green. It pays a real signed authorisation through the
      deployed Sepolia splitter and reads the split from the transaction receipt — not
      from balances polled afterwards, which race a load-balanced RPC and reported a
      correct split as a failure the first time it ran.
- [ ] The Sepolia `Payment` event shows the 98/2 split, read from the chain.
- [x] The twelve shared vectors agree between the **deployed** Sepolia contract
      (`0xDfE85CEe…3d92`, read with `eth_call` against `feeFor`) and `platformFee()` from
      the **published** `@fatstack/x402@0.2.0` — not the workspace source. Re-checked
      2026-09-08: all twelve agree three ways. Re-run against the mainnet contract
      immediately after deploying.

---

## Deploying

```bash
cd contracts

USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
TREASURY_ADDRESS=0x07cA3A6BA32ecB2CF209d9Fb1e2fE8074D4e9946 \
forge script script/Deploy.s.sol \
  --rpc-url $BASE_RPC_URL \
  --broadcast \
  --verify \
  --ledger        # or --trezor, or --interactive
```

Deploy the **factory only** first. Leave `PROVIDER_ADDRESS` unset. Then read every value
back off the chain (`POST_DEPLOY.md` step 2) before deploying any provider's splitter.

---

## Immediately after

- [ ] Source verified on Basescan for both contracts.
- [ ] `PROVIDER`, `TREASURY`, `USDC`, `FEE_BPS` read back from the chain and match.
- [ ] `feeFor(149) == 2`, `feeFor(49) == 0`, `feeFor(1000000) == 20000` on the deployed
      contract.
- [ ] `SPLITTER_FACTORY_ADDRESS` set for both the registry and the indexer; both redeployed.
- [ ] One real payment through the splitter, verified on the chain — not from a log.

---

## What could still go wrong

Stated plainly, because you are the one accepting these.

**It has not been audited.** The tests are thorough and the fork test uses real USDC, but
no third party has reviewed it. The contract is small, immutable and has no privileged
functions, which makes an audit cheap and a mistake permanent. For meaningful volume, get
one.

**A wrong treasury is forever.** No owner, no setter. The only remedy is deploying a new
factory and abandoning the old one.

**Stranded funds are unrecoverable.** USDC sent to a splitter by any route other than a
payment is stuck. There is no sweep, deliberately: a sweep is a function that moves money
nobody authorised, and that is exactly the capability the platform promises never to have.

**`toolId` is advisory.** It is not covered by the payer's signature. It labels a payment
for the indexer; it cannot redirect one. Attribution still comes primarily from the
settlement record.

**The deadline is real.** Providers begin leaving their promotional window on
**2026-10-01**. From then, a provider with no deployed splitter cannot be served at all —
the registry answers 409 and their listings go dark. The indexer starts alerting 14 days
out. That is the schedule this contract exists to meet.

---

## Rollback

Unset `SPLITTER_FACTORY_ADDRESS` and redeploy the web app. Post-promo listings stop being
served rather than being quoted against a contract you no longer trust; promo-phase
listings are untouched, because they pay providers directly and never reach the contract.

No rollback recovers a settled payment.
