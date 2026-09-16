#!/usr/bin/env node
import { createInterface } from 'node:readline';

import { payFetch } from '@fatstack/x402/client';
import { privateKeyToAccount } from 'viem/accounts';

import { relay, type RelayDeps } from './bridge.js';
import { canPay, envSchema } from './env.js';

/**
 * Entry point: newline-delimited JSON on stdin, the same on stdout.
 *
 * Everything diagnostic goes to stderr. stdout carries the protocol and nothing else — a
 * stray log line there is a parse error in the client, and it is the classic way a working
 * stdio server looks broken.
 */
async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      process.stderr.write(`fatstack-mcp: ${issue.path.join('.')}: ${issue.message}\n`);
    }
    process.exit(2);
  }
  const env = parsed.data;

  const fetchImpl: RelayDeps['fetchImpl'] = canPay(env)
    ? async (url, init) =>
        payFetch(url, init, {
          wallet: privateKeyToAccount(env.FATSTACK_AGENT_KEY as `0x${string}`),
          networks: [env.FATSTACK_NETWORK],
          guards: {
            maxPerDay: env.FATSTACK_MAX_PER_DAY,
            ...(env.FATSTACK_MAX_PER_CALL === undefined
              ? {}
              : { maxPerCall: env.FATSTACK_MAX_PER_CALL }),
          },
        })
    : async (url, init) => fetch(url, init);

  process.stderr.write(
    `fatstack-mcp: relaying to ${env.FATSTACK_MCP_URL} — ` +
      (canPay(env)
        ? `paying on ${env.FATSTACK_NETWORK}, max $${env.FATSTACK_MAX_PER_DAY}/day. ` +
          `Payments are final: no refunds, no chargebacks.\n`
        : `discovery only (no FATSTACK_AGENT_KEY); paid calls will return their 402 quote.\n`),
  );

  const deps: RelayDeps = { endpoint: env.FATSTACK_MCP_URL, fetchImpl };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim() === '') continue;
    const out = await relay(line, deps);
    if (out !== null) process.stdout.write(`${out}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `fatstack-mcp: ${error instanceof Error ? error.message : 'unknown failure'}\n`,
  );
  process.exit(1);
});
