import { z } from 'zod';

/**
 * Spend guards are required, not defaulted.
 *
 * These tools hand an autonomous agent a wallet and a catalogue. The failure mode is not a
 * bad answer, it is a drained wallet, and it happens while nobody is watching. A default
 * would be a number chosen by us for somebody else's money, and an optional cap would be
 * absent exactly when a loop goes wrong — so the constructor refuses to build anything
 * without one.
 *
 * `maxPerDay` specifically, rather than only a per-call cap: a per-call limit does nothing
 * against a thousand cheap calls, which is the shape a runaway agent actually has.
 */
export const guardsSchema = z.object({
  /** Hard ceiling on total spend per UTC day, in USD. */
  maxPerDay: z.number().positive().finite(),
  /** Optional ceiling on any single call, in USD. */
  maxPerCall: z.number().positive().finite().optional(),
});

export type SpendGuards = z.infer<typeof guardsSchema>;

export class MissingSpendGuardError extends Error {
  constructor(detail: string) {
    super(
      `@fatstack/ai-sdk-tools requires a spend guard: ${detail}. These tools let an agent ` +
        'spend real USDC on its own initiative, so there is no default cap — a default ' +
        'would be us choosing a number for your money. Pass guards: { maxPerDay: 1.00 } ' +
        'with a figure you are willing to lose.',
    );
    this.name = 'MissingSpendGuardError';
  }
}

/** Validates guards, throwing a message that says what to do rather than what failed. */
export function requireGuards(guards: unknown): SpendGuards {
  if (guards === undefined || guards === null) {
    throw new MissingSpendGuardError('no `guards` were provided');
  }
  const parsed = guardsSchema.safeParse(guards);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'guards';
    throw new MissingSpendGuardError(`\`${path}\` ${issue?.message ?? 'is invalid'}`);
  }
  if (parsed.data.maxPerCall !== undefined && parsed.data.maxPerCall > parsed.data.maxPerDay) {
    throw new MissingSpendGuardError(
      `maxPerCall (${parsed.data.maxPerCall}) exceeds maxPerDay (${parsed.data.maxPerDay}), ` +
        'so the daily cap could never bind',
    );
  }
  return parsed.data;
}
