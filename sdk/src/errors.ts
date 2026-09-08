/** Names of the spend guards an agent can set. */
export type GuardName = 'maxPerCall' | 'maxPerHour' | 'maxPerDay' | 'allowedHosts';

/**
 * Thrown before anything is signed when a call would breach a spend guard.
 *
 * Payments are final, so the only place to stop an unwanted spend is before the
 * signature exists. Every guard raises this, and it is never thrown after a payment
 * payload has been created.
 */
export class SpendGuardError extends Error {
  override readonly name = 'SpendGuardError';

  constructor(
    readonly guard: GuardName,
    message: string,
    readonly detail: { limitUsd?: number; attemptedUsd?: number; host?: string } = {},
  ) {
    super(message);
  }
}

/** Thrown by seams that are typed and reachable but deliberately not built yet. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';

  constructor(feature: string) {
    super(`${feature} is not implemented in this build.`);
  }
}

/** Thrown when an optional framework adapter is used without its package installed. */
export class MissingAdapterError extends Error {
  override readonly name = 'MissingAdapterError';

  constructor(pkg: string) {
    super(`${pkg} is not installed. Add it to use this adapter: pnpm add ${pkg}`);
  }
}

/**
 * A 402 arrived whose payment requirements could not be read, so the call cannot be
 * priced and therefore cannot be checked against a spend cap. Refusing is the safe
 * outcome: paying blind is irreversible.
 */
export class UnreadableQuoteError extends Error {
  override readonly name = 'UnreadableQuoteError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * The server rejected a request that already carried a payment.
 *
 * This is the settlement-failure case and it is not the same as a fresh quote: the agent
 * has already signed, so re-quoting is wrong and retrying may double-spend. It surfaces
 * separately because the two look identical on the wire — both are a 402 without readable
 * requirements — and reporting a failed settlement as an unreadable quote sends whoever is
 * debugging it to the wrong side of the system entirely.
 */
export class PaymentRejectedError extends Error {
  override readonly name = 'PaymentRejectedError';

  constructor(
    message: string,
    readonly detail: { status: number; body: string } = { status: 402, body: '' },
  ) {
    super(message);
  }
}
