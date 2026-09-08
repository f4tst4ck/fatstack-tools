# Security review — FatstackSplitter

Contracts: `src/FatstackSplitter.sol`, `src/FatstackSplitterFactory.sol`
Solidity 0.8.28 · 31 tests, including a Base fork test against real USDC
Reviewed 2026-09-02. **Not audited by a third party.**

---

## What the contract can and cannot do

It receives an EIP-3009 authorised USDC payment and splits it: `floor(2%)` to the
treasury, the remainder to one provider. That is the whole surface.

- **No owner, no pause, no proxy, no upgrade path.** There is no privileged call, so
  there is no key whose loss or theft matters.
- **No withdraw and no sweep.** The only function that moves money is a payment the payer
  signed. USDC arriving by any other route is unrecoverable, which is a deliberate
  trade — see [Stranded funds](#accepted-stranded-funds).
- **Nothing is held between transactions.** The pull and the split happen in one call, so
  the contract's balance is zero outside a transaction and there is nothing to drain.

---

## The finding that changed the design

**An unsigned `provider` argument would have let a bystander take the payment.**

An earlier draft took `provider` as a parameter of `payWithAuthorization`. An EIP-3009
signature covers `(from, to, value, validAfter, validBefore, nonce)` — and nothing else.
`provider` was therefore attacker-chosen: anyone who saw a pending authorisation, in the
mempool or anywhere else, could submit it themselves with their own address and receive
the provider's 98%.

`receiveWithAuthorization` does not help here. It stops a third party front-running the
_transfer_ by requiring `msg.sender == to`, but the recipient in this design is the
splitter, and the splitter was letting its caller choose where the money went next.

**Fix:** the provider is fixed at construction, one splitter per provider, deployed by a
CREATE2 factory so the address is derivable from the provider alone. The argument is gone,
and with it the attack. `test_aStolenAuthorizationStillPaysTheProvider` submits a valid
authorisation from an attacker's account and asserts the provider is paid anyway.

This was found by reviewing the contract adversarially before deployment, not by a tool —
slither does not flag it, because nothing in the code is wrong in isolation. It is wrong
only in relation to what the signature covers.

---

## Slither

`slither . --filter-paths "lib|test|script"` — **10 results, 0 requiring a change.**
Each is listed with why it stands.

### `incorrect-equality` ×2 — not applicable

`amount == 0` and `received == 0`. The detector targets equality against balances or
timestamps, where an exact match is fragile. These compare a computed integer against
zero, which is exact by definition.

### `reentrancy-events` ×1 — correct as written

`Payment` is emitted after the transfers. Emitting it first would announce a payment that
could still revert, and an indexer consuming that event would record revenue that never
happened. The ordering is deliberate: the event is a record of something that has already
succeeded. No state is read after the external calls, so there is nothing for a reentrant
call to corrupt.

### `low-level-calls` ×1 — deliberate

`_transfer` uses a low-level call so it can accept both a token that returns a bool and
one that returns nothing, and reject a `false` return. A plain `IERC20.transfer` would
revert on the no-return case and, worse, would silently ignore a `false`. Tested by
`test_revertsWhenTokenTransferReturnsFalse`.

### `naming-convention` ×5 — deliberate

`USDC`, `PROVIDER`, `TREASURY` are immutables written in the style of constants because
that is what they are to every reader of the ABI: values fixed at construction that can
never change. Renaming them to `usdc` would suggest mutability the contract does not have.

### `too-many-digits` ×1 — inherent

The CREATE2 prefix `0xff` and the address mask in `splitterFor`. This is the standard
address-derivation formula.

---

## Threat model

| Threat                                           | Outcome                                                                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attacker submits an observed authorisation       | Provider is paid; attacker pays the gas. **Tested.**                                                                                                            |
| Attacker mislabels `toolId`                      | Labels only. No money moves differently. Attribution is not taken from this event alone. **Tested.**                                                            |
| Replay of a settled authorisation                | USDC burns the nonce; the second call reverts. **Tested on a fork against real USDC.**                                                                          |
| Token returns `false` from `transfer`            | Whole payment reverts; payer keeps their money. **Tested.**                                                                                                     |
| Token reverts on `transfer`                      | Whole payment reverts. **Tested.**                                                                                                                              |
| Token re-enters during a transfer                | Payment settles exactly once, nothing stranded. **Tested.** USDC does not do this; the test exists because "the configured token would never" is an assumption. |
| Fee-on-transfer token delivers less than `value` | Splits what arrived, not what was asked. **Tested.**                                                                                                            |
| Treasury transfer fails                          | Whole transaction reverts. The platform never holds a provider's revenue, even briefly.                                                                         |
| Zero address as provider, treasury, or token     | Constructor reverts. **Tested.**                                                                                                                                |
| Provider set to the splitter itself              | Constructor reverts — it would strand every payment irrecoverably. **Tested.**                                                                                  |
| Deployer deploys someone else's splitter         | Permitted and pointless: the result can only pay that provider. **Tested.**                                                                                     |
| Rounding pushed in the platform's favour         | Impossible: `floor` is the only operation, and a fuzz test asserts the fee never exceeds an exact 2%.                                                           |

---

## Accepted: stranded funds

USDC transferred to a splitter by any route other than `payWithAuthorization` cannot be
recovered by anyone.

This is accepted rather than fixed. A sweep function is a function that moves money nobody
authorised in that transaction, and adding one — even one hard-coded to the treasury —
would give the contract precisely the capability the platform promises never to have. The
non-custodial claim is worth more than the recovery of an accidental transfer.

Payments are atomic, so the contract holds nothing in normal operation. The realistic path
to stranded funds is somebody manually sending USDC to the address, and the mitigation is
documentation rather than code.

## Accepted: `toolId` is advisory

It is not covered by the payer's signature, so a submitter can label a payment as any
listing. It is emitted because an indexer needs a hint, not a proof — revenue attribution
comes from the settlement record written at payment time, and the reconciliation job
compares that against the chain.

## Not audited

No third party has reviewed this. The tests are thorough and the fork test exercises real
USDC, but neither is an audit. Before this handles meaningful volume it should have one —
the contract is small, immutable and has no privileged functions, which makes it a cheap
thing to audit and a difficult thing to fix afterwards.

---

## Second hostile-review pass — 2026-09-02

A second adversarial pass over the final code, after the provider-parameter fix. It found
no new way to move money to the wrong place. Three behaviours were unproven rather than
wrong, and are now pinned by tests.

**A stray donation is not paid out by the next payment.**
`payWithAuthorization` computes what it received from a balance _delta_, not from the
contract's balance. Had it used the balance, USDC sent to the splitter by mistake would be
handed to whoever paid next — someone else's money, moved by a payment nobody authorised.
`test_aStrayDonationIsNotPaidOutByTheNextPayment` holds this. The donation stays stranded,
which is the deliberate trade documented above: a sweep is a function that moves
unauthorised money, and that is the exact capability the platform promises never to have.

**Provider equal to treasury conserves every base unit.**
Not hypothetical — the first Sepolia deployment had it, which made the split untestable
because both halves landed in one wallet. It is a misconfiguration, not a vulnerability:
nothing is lost or duplicated, the platform simply collects no fee. The go/no-go checklist
blocks it and `test_providerEqualToTreasuryStillConservesEveryBaseUnit` pins it.

**An absurd amount reverts rather than miscomputing.**
`amount * 200` overflows above `type(uint256).max / 200`; Solidity 0.8 reverts, so the
payment fails and the payer keeps their money. No real USDC amount comes close — total
supply is around 1e16 base units — but "reverts" and "returns a wrong fee" are very
different failures and only one is safe.

### Checked and found sound, no change needed

- **Front-running the CREATE2 deployment.** Anyone may deploy any provider's splitter. The
  result is byte-identical and can only pay that provider, so there is nothing to win.
- **Reentrancy.** The token is immutable and is USDC. A reentrant token cannot be
  substituted after construction; `test_reentrantTokenCannotDrainOrDoubleSpend` covers the
  mock case anyway.
- **Fee inflation.** `feeFor` floors, and the provider takes the remainder. There is no
  input, caller or ordering that makes the treasury's share exceed an exact 2%.
- **Zero-fee payments.** Below 50 base units the fee floors to zero and the provider is
  paid in full. That is the flat-2%-no-minimum rule working as specified, not a rounding
  bug.

### Verified against the deployed contract, not only in tests

All twelve shared vectors were evaluated by `eth_call` against the **deployed Sepolia
splitter** and compared with the TypeScript `platformFee()` the registry quotes from. They
agree exactly, including every rounding edge. This matters more than the forge assertion:
a forge test proves the source is consistent with itself, while this proves the bytecode
actually on chain agrees with the price a provider is quoted. A divergence here would mean
the split and the quote disagree, and the payment is final by the time anyone notices.

---

## Facilitator audit — 2026-09-03

A separate adversarial audit covers the payment path rather than the contract: replay,
concurrency, cross-resource reuse, verify/settle ordering, field binding and resource
abuse. It lives in `facilitator/THREAT-MODEL.md`, with the suite in
`facilitator/test/adversarial/` running against a real facilitator and real settlements on
Base Sepolia.

### Class 3 — cross-resource free-riding: found, reproduced, fixed, pinned

**Found.** An EIP-3009 signature covers `(from, to, value, validAfter, validBefore, nonce)`
and says nothing about _what was bought_. Two tools from one provider at one price
therefore quote byte-identical payment requirements. The x402 payload does carry a
`resource` naming the intended tool — nothing compared it, and the requirements our
resource server forwards to the facilitator contain no resource at all, so the facilitator
was structurally unable to check it even in principle.

**Reproduced on chain.** A fresh authorisation minted for `adversarial-tool-a` was
presented to `adversarial-tool-b`. Verification returned `isValid: true`, settlement
succeeded on Base Sepolia, and tool B served its body:

> `0xd95ea771333c8f33f346c316fad30a64585156831d09e298d501c5b1e17e5659`

**Fixed** in `sdk/src/resource-binding.ts`, enforced in `honoPaywall` — the single layer
both the SDK and the edge proxy pass through, and the only one that knows the URL actually
called. A payment naming a different resource is refused **before the facilitator is
contacted**: no verify, no settle, and the payer keeps their money rather than buying a
tool they did not ask for. Confirmed in the live run, where the facilitator saw no requests
at all on a mismatch.

**Pinned by regression tests.** `sdk/src/resource-binding.test.ts` (11 cases, no
infrastructure needed) and `facilitator/test/adversarial/attacks.test.ts` under _class 3_
(3 cases, against real settlements), plus the wire-level proof in `wire-proof.test.ts`.

One further defect was found in the shape of a correct refusal: an unsupported network
threw and became a `500`, which a caller cannot distinguish from an outage. It now returns
a clean `isValid: false`.

The remaining four classes were already safe, and the threat model records _why_ — chiefly
that nothing is served until settlement succeeds, and that the one-authorisation-one-payment
invariant rests on the EIP-3009 nonce on chain rather than on any state we keep.

---

## Operating policy: a suite that cannot run proves nothing

> **A security suite that cannot run proves nothing — silence from it must be
> indistinguishable from failure, never from a pass.**

This is a standing rule, not an observation. Every automated check that guards something
here has failed _quietly_ at least once: a canary that ran out of testnet funds, a probe
pointed at a subdomain that no longer routed, an outage that ran five hours while the
probes recorded it faithfully and told nobody. In each case the dashboard was green
because nothing was looking, and green-because-nothing-looked is the most expensive state
a monitoring system can be in.

Two enforcement points hold this rule for the adversarial suite, and both must stay:

1. **The funded-runway alert.** The suite spends real testnet USDC. The indexer watches the
   payer wallet and alerts #alerts at or below three weekly runs, naming the wallet, the
   balance and the top-up. An empty wallet is therefore announced _before_ it can turn the
   suite silent. Warned on remaining runs rather than a balance, because the same dollar
   figure means different things to checks that spend at different rates.
2. **The refuse-to-run-blind step.** The weekly workflow fails, by name and per secret, if
   any credential it needs is absent, and fails again if the run reports skipped tests. A
   suite whose secrets are missing would otherwise skip every live case and report success
   — the precise failure this policy exists to forbid.
3. **The silence watchdog.** The indexer checks daily whether the suite has settled anything
   on Base Sepolia and pages #alerts after eight days of nothing. It asks the _chain_ rather
   than the Actions API, because a run that starts, fails to configure itself and exits
   would satisfy GitHub while proving nothing. This is what covers the case the other two
   cannot: a cron that simply stopped firing, which produces no failed run to notice.

The same reasoning is why the weekly workflow reports to #alerts on success as well as
failure. A green message every week is evidence the thing ran; no message at all is
ambiguous, and ambiguity is what this rule removes.
