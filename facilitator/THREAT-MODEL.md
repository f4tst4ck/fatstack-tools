# Facilitator threat model

Adversarial audit of the self-hosted x402 facilitator and the resource-server path in
front of it, against the flaw classes documented in mid-2026 research on production x402
facilitators.

**Method.** Every verdict below was produced by running the attack against a real
facilitator, real paywalled resources on real sockets, and real settlements on Base
Sepolia — not against mocks. That distinction earned its place: a mocked version of this
suite passes class 3, which was genuinely exploitable. The suite lives in
`facilitator/test/adversarial/` and runs in CI.

**Audited 2026-09-03.** One class was found vulnerable and fixed. One was found safe but
failing in the wrong shape and was cleaned up. Four were already safe.

---

## Serve / settle ordering

The single most important property here, because most of the classes below depend on it.

```
   agent                resource server            facilitator              Base
     │                        │                        │                     │
     │──── request ──────────>│                        │                     │
     │<─── 402 + quote ───────│                        │                     │
     │                        │                        │                     │
     │──── request + auth ───>│                        │                     │
     │                        │ [A] resource binding   │                     │
     │                        │     (local, no I/O)    │                     │
     │                        │──── verify ───────────>│                     │
     │                        │                        │─── read state ─────>│
     │                        │<─── isValid ───────────│                     │
     │                        │                        │                     │
     │                        │ [B] handler runs, response held, not sent    │
     │                        │                        │                     │
     │                        │──── settle ───────────>│                     │
     │                        │                        │─── broadcast ──────>│
     │                        │                        │<── receipt ─────────│
     │                        │<─── success ───────────│                     │
     │                        │                        │                     │
     │<─── 200 + body ────────│  only if settle succeeded                    │
     │<─── 402, no body ──────│  if settle failed                            │
```

The x402 `exact` scheme uses the `authorization` flow: `verifyBeforeHandler: true`,
`settleBeforeHandler: false`, `settleAfterHandler: true`. The handler executes before
settlement, but its response is a value held in the middleware — on settlement failure it
is replaced with a 402 and never reaches the client.

**Exposure window: none for the response body.** There is no point at which a body is
released on the strength of verification alone. Verified by test, not by reading the flow.

**What is exposed:** the provider's handler _runs_ before settlement is known to succeed.
For a read-only tool that costs compute. For a handler with side effects — sending mail,
minting something — the side effect happens even when the payment ultimately fails. That
is a property of the `authorization` flow rather than a defect in our code, and providers
whose handlers have external side effects should know it. Documented rather than fixed,
because fixing it means the `upfront` flow, which settles before the handler and changes
the latency and refund story for every tool.

---

## 1. Replay across time — **SAFE**

_Can a proof pass verification twice? Can a settled authorisation still unlock a response?_

**Evidence.** A settled authorisation replayed at the same tool: `/verify` answered
`isValid: true`, then `/settle` reverted with
`FiatTokenV2: authorization is used or canceled`, and the response was `402` with no body.
Replayed at all three tools afterwards: none served.

**Verification is racy on its own, and that is expected.** Verify reads chain state, and a
node that has not yet seen the settling block will call a spent authorisation valid. The
invariant is not defended by verification — it is defended by the EIP-3009 nonce at
settlement, and by the fact that nothing is served until settlement succeeds.

**Idempotency record.** The persistent record required by the invariant is the EIP-3009
nonce in the USDC contract itself. It is durable, atomic, shared by every isolate and
every deployment, and it cannot be lost by us. A database table mirroring it would add a
second source of truth that can disagree with the chain — and when those two disagree, the
chain is right and the table is a liability. We rely on the chain deliberately, and the
tests pin the behaviour rather than the mechanism.

Tests: `attacks.test.ts` → _class 1 — replay across time_ (2).

## 2. Concurrency race on one authorisation — **SAFE**

_Two simultaneous requests carrying the same payment header._

**Evidence.** Two genuinely parallel HTTP requests, one unspent authorisation, no mock
around the critical section. Both passed verification — both read the nonce as unspent —
and both ran their handler. At settlement one broadcast won and the other was rejected by
the node (`already known`, then `authorization is used or canceled`). Exactly one 200. The
same held across two different tools in parallel.

**Which guard holds, explicitly.** Not an in-memory lock — there isn't one, and it would
be worthless across Worker isolates. Not KV, which is eventually consistent and would let
two isolates both believe they held the claim. The guard is the **EIP-3009 nonce on
chain**, which is atomic at the only place both requests must pass through. Concurrency
cannot beat it because both settlements target the same nonce in the same contract.

**The cost that is not covered:** both handlers ran. One payment, two executions of the
provider's code, one served response. See the ordering note above.

Tests: `attacks.test.ts` → _class 2 — concurrency race_ (2).

## 3. Cross-resource free-riding — **VULNERABLE, FIXED**

_An authorisation for tool A used at tool B: same provider, same price._

**Reproduced, live, before the fix.** A fresh authorisation minted against
`adversarial-tool-a` was presented to `adversarial-tool-b`. The facilitator answered
`isValid: true`, settlement succeeded on chain
(`0xd95ea771333c8f33f346c316fad30a64585156831d09e298d501c5b1e17e5659`), and tool B returned
`{"served":true,"toolId":"adversarial-tool-b"}`.

**Root cause.** An EIP-3009 signature covers `(from, to, value, validAfter, validBefore,
nonce)` and nothing about _what was bought_. Two tools from one provider at one price
therefore quote byte-identical payment requirements and are indistinguishable to every
check that ran. The x402 payload does carry a `resource` naming what the payer believed
they were buying — and the requirements our resource server forwards to the facilitator
contain no resource at all (`scheme, network, amount, asset, payTo, maxTimeoutSeconds,
extra`), so the facilitator was structurally unable to compare them even in principle.

**Fix.** `sdk/src/resource-binding.ts`, enforced in `honoPaywall` — the one layer that
knows the URL actually called, and the layer both the SDK and the edge proxy pass through.
A payment naming a different resource is refused with `resource_mismatch` **before** the
facilitator is called: no verify, no settle, and the payer keeps their money rather than
buying something they did not ask for. Confirmed in the live run — the facilitator saw no
requests at all on a mismatch.

**Not a quote change.** The `resource` field was always published in the 402 and always
signed into the payload by the client. This starts checking a field that was already
there, so no integrated payer needs to change anything. Comparison is origin + path, with
query strings ignored, trailing slashes normalised, and host compared case-insensitively —
strict equality would reject honest payers over a trailing slash.

**Sibling case — amount mismatch: already SAFE.** A `$0.001` authorisation presented to a
`$0.010` tool was refused (`402`) both before and after the fix.

Tests: `attacks.test.ts` → _class 3_ (3), `sdk/src/resource-binding.test.ts` (11).

## 4. Verify–settle gap — **SAFE**

See the diagram above. The observed call order on an honest payment is exactly
`/verify` → `/settle`, with `"success":true` on the settle that precedes the served body.
On a failed settlement the body is withheld and the client receives a 402.

**Behaviour when settlement reverts.** The response is not released, so there is nothing to
claw back. The facilitator logs `settle_failed` with the revert reason. The blocklist-after-N
escalation described in the task is **not implemented** and is called out here rather than
quietly skipped: with the response withheld, a reverting settlement costs us gas and the
payer nothing, which is an abuse-cost problem rather than a free-riding one — it is
addressed by the class 6 rate limits, and a payer blocklist is the next step if the ratio
alarm ever fires in anger.

Tests: `attacks.test.ts` → _class 4_ (2).

## 5. Field binding — **SAFE** (one defect in the failure _shape_, fixed)

Each field was tested by driving `/verify` with a genuine authorisation and one field
disagreeing. All rejected:

| Field                                              | Result                            |
| -------------------------------------------------- | --------------------------------- |
| `payTo` mismatched                                 | rejected                          |
| `payTo` missing                                    | rejected — absence is not a match |
| `amount` mismatched                                | rejected                          |
| `asset` (token contract) mismatched                | rejected                          |
| `validBefore` in the past                          | rejected                          |
| `validAfter` in the future                         | rejected                          |
| `network` / chain id mismatched                    | rejected                          |
| **Base Sepolia authorisation on the mainnet path** | rejected _(named regression)_     |

**Defect found and fixed.** An unsupported network made the facilitator _throw_, which the
error handler turned into `500 internal_error`. The payment was correctly refused, but a
500 says "we fell over" rather than "this payment is wrong" — the caller cannot tell which,
and one is worth retrying while the other never is. It also left an unhandled exception
reachable from a request body on the endpoint guarding our gas. `/verify` now returns
`{ isValid: false, invalidReason: 'unsupported_network_or_scheme' }`.

Tests: `field-binding.test.ts` (9).

## 6. Facilitator resource abuse — **MITIGATED**

Verification is free to the caller and costs us RPC quota; settlement costs gas. Both sit
behind an API key, so the realistic abuser is a misbehaving or compromised integration
rather than a stranger — a quiet drain, which is the kind that runs for a week unnoticed.

- **Per-IP and per-payer limits**, 120 verify/min and 30 settle/min. Settle is far tighter
  because it spends gas. Per-payer as well as per-IP because one wallet behind rotating
  addresses is the same abuser, and the payer is the identity that costs us something.
- **Verify-to-settle ratio alarm** at 20:1 over a floor of 50 verifies. An honest client
  sits near 1:1 and a retrying one a little above; 20 verifies per settle is farming our
  RPC quota as a free signature oracle.

**Consistency, stated plainly.** The limiter uses KV when `RATE_KV` is bound and a
per-isolate counter otherwise, and **it is approximate either way** — KV is eventually
consistent, so a burst across isolates can overshoot. That is acceptable here and only
here: this counter bounds _cost_, not correctness. Nothing about payment integrity depends
on it. The payment invariant is enforced by the on-chain nonce, which is atomic.

Tests: `src/ratelimit.test.ts` (12).

---

## Running the suite

```bash
pnpm --filter @fatstack/facilitator run test:adversarial
```

It is **not** part of `pnpm test`. Each pass settles eleven real payments on Base Sepolia, so binding it to every commit would spend testnet USDC continuously and empty the
payer wallet within a day. It runs on demand and weekly in CI.

**It needs funding.** The payer `0xBA617EEab7B34202eC4047315056163E52FA3218` must hold Base
Sepolia USDC and the facilitator signer must hold Sepolia ETH for gas. The suite checks
this first and fails with a plain message naming the wallet, because "insufficient balance"
surfacing from a settlement looks like a broken payment path and is not one.

## Found and fixed: the registry disclosed provider origins

**2026-09-08. Fixed the same day.**

`GET /api/registry/tools/<slug>` returned `upstreamUrl` — the address of the provider's own
server behind `<slug>.fatstack.net` — to any unauthenticated caller. The endpoint exists so
the edge Worker can resolve where to forward a paid request; it was reachable by everyone.

**Why it matters.** A paywall works by being the only route to the resource. Publishing the
origin gives an agent a second route, and for any origin that answers whoever reaches it,
that route is free. Nothing on chain is at risk — no key, no funds, no settled payment — but
a provider could have been billed nothing for work they performed.

**What was actually reachable.** Our own seed-tool origins answered `404` on every path
probed, so no bypass was demonstrated against them. Third-party origins are the provider's
own servers and were never ours to test. The disclosure is treated as exploitable regardless:
"we could not find the open door" is not "there is no open door".

**Fixed in two layers, because either alone is thin.**

1. **The origin is no longer public.** `upstreamUrl` is disclosed only to a caller
   presenting `x-fatstack-internal`. Everyone else gets `url` — the public subdomain, which
   is where a caller should send the request anyway. With the secret unset nothing internal
   is disclosed to anyone: a missing secret must reveal less, never more.
2. **A leaked origin is worth nothing.** Our proxy-mode origin Workers refuse any request
   that does not carry `x-fatstack-origin`, answering `404` rather than `403` so a refusal
   does not confirm that something is there. That secret is sent only to an allowlist of
   exact hostnames — never to every upstream, since the proxy also forwards to third-party
   providers, and telling all of them would be a wider leak than the one being closed. A
   client-supplied copy of the header is stripped before forwarding, so nobody can mint it.

Layer 2 is what makes the already-public disclosure recoverable. Layer 1 alone would only
stop the next leak, not the one that already happened.

**Regressions.** A test in the registry service scans public payloads for internal
hostnames and origin-shaped keys, rather than asserting field by field — a rule about every
public response should not be a checklist a new field can slip past. It is checked against
the exact payload that shipped, so it fails without the fix.

**What this does not cover.** A provider whose own origin is guessable and unauthenticated
can still be called directly by anyone who finds it. That is true of any x402 deployment and
is why the SDK binds a payment to its resource. Providers should treat their origin as
reachable and put the paywall at the origin, not in front of it.

## What this audit does not cover

- **The signer key.** The facilitator's hot key pays gas and holds no user funds, so a
  compromise costs gas rather than payments. It is currently a key that has been exposed
  and is awaiting rotation, which is tracked separately and is not a finding of this audit.
- **Provider handlers.** A provider's own code runs before settlement is final. We
  document the window; we cannot police what their handler does in it.
- **Formal verification of the x402 libraries.** We test the behaviour of the composed
  system, not the internals of `@x402/core`.
