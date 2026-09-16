import { z } from 'zod';

/**
 * A stdio MCP server that relays to the hosted Fatstack aggregator.
 *
 * The catalogue lives at `https://www.fatstack.net/api/mcp` and speaks streamable HTTP.
 * Plenty of MCP clients only speak stdio, and Glama's directory only scores servers it can
 * start from a repository. This is the shim for both: one process, stdin to stdout, every
 * message forwarded verbatim.
 *
 * **It is a relay, not a participant.** It never mints a quote, never rewrites a price, and
 * never becomes a payee — the same rule the aggregator itself holds to. When a call needs
 * paying, the provider's own 402 comes back through unaltered.
 *
 * **Payment is optional and local.** Without a wallet the bridge does discovery and relays
 * the 402 that says what a call would cost. With `FATSTACK_AGENT_KEY` set it pays through
 * the SDK's `payFetch`, which requires spend guards. The key is read from the environment of
 * the process the user started, on the user's machine; it is never transmitted to Fatstack
 * and nothing here writes it anywhere.
 */

/** Newline-delimited JSON is the stdio transport's framing. */
export const jsonRpcMessage = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

export type JsonRpcMessage = z.infer<typeof jsonRpcMessage>;

/** A notification carries no id and must never be answered — answering one is a protocol error. */
export function isNotification(message: JsonRpcMessage): boolean {
  return message.id === undefined;
}

export interface RelayDeps {
  endpoint: string;
  /** Plain `fetch`, or one that pays, depending on whether a wallet was configured. */
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export const RELAY_ERROR = -32_010;

/** JSON-RPC error object for something that went wrong on this side of the wire. */
export function relayError(id: JsonRpcMessage['id'], message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: RELAY_ERROR, message },
  });
}

/**
 * Forward one message and return what should be written to stdout, or `null` for nothing.
 *
 * A non-2xx from the aggregator is reported as a relay error rather than swallowed. A bridge
 * that answers "no tools" when it could not reach the catalogue is indistinguishable from a
 * catalogue that is empty, and the client cannot tell that it should retry.
 */
export async function relay(raw: string, deps: RelayDeps): Promise<string | null> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return relayError(undefined, 'malformed JSON on stdin');
  }

  const message = jsonRpcMessage.safeParse(parsedJson);
  if (!message.success) {
    return relayError(undefined, 'not a JSON-RPC 2.0 message');
  }

  let response: Awaited<ReturnType<RelayDeps['fetchImpl']>>;
  try {
    response = await deps.fetchImpl(deps.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: raw,
    });
  } catch (error) {
    if (isNotification(message.data)) return null;
    return relayError(
      message.data.id,
      `cannot reach ${deps.endpoint}: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown'}`,
    );
  }

  const body = await response.text();

  // A notification gets no reply even when the upstream sends one back.
  if (isNotification(message.data)) return null;

  if (!response.ok && body.trim() === '') {
    return relayError(message.data.id, `aggregator returned HTTP ${response.status} with no body`);
  }

  return body.trim() === '' ? null : body.trim();
}
