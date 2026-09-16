import { z } from 'zod';

/**
 * Configuration, parsed at the boundary.
 *
 * The wallet is optional. What is not optional is a spend cap alongside it: a process that
 * can sign payments and has no ceiling is a drained wallet waiting for a bad tool choice, and
 * payments are final. So `FATSTACK_MAX_PER_DAY` is required whenever a key is present, and
 * the bridge refuses to start without it rather than defaulting to a number we picked for
 * someone else's money.
 */
export const envSchema = z
  .object({
    FATSTACK_MCP_URL: z.string().url().default('https://www.fatstack.net/api/mcp'),
    FATSTACK_AGENT_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'FATSTACK_AGENT_KEY must be a 32-byte hex private key')
      .optional(),
    FATSTACK_MAX_PER_DAY: z.coerce.number().positive().optional(),
    FATSTACK_MAX_PER_CALL: z.coerce.number().positive().optional(),
    FATSTACK_NETWORK: z.enum(['base', 'base-sepolia']).default('base'),
  })
  .superRefine((env, ctx) => {
    if (env.FATSTACK_AGENT_KEY && env.FATSTACK_MAX_PER_DAY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FATSTACK_MAX_PER_DAY'],
        message:
          'FATSTACK_AGENT_KEY is set, so FATSTACK_MAX_PER_DAY is required. A signer with no ' +
          'daily ceiling can spend the whole wallet, and payments are final — there are no ' +
          'refunds and no chargebacks.',
      });
    }
  });

export type BridgeEnv = z.infer<typeof envSchema>;

/** Whether this process can pay, or is discovery-only. */
export function canPay(env: BridgeEnv): boolean {
  return env.FATSTACK_AGENT_KEY !== undefined;
}
