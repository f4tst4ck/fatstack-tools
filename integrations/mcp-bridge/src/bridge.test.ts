import { describe, expect, it } from 'vitest';

import { isNotification, relay, RELAY_ERROR, type RelayDeps } from './bridge.js';
import { canPay, envSchema } from './env.js';

const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });

const deps = (
  impl: RelayDeps['fetchImpl'],
  endpoint = 'https://www.fatstack.net/api/mcp',
): RelayDeps => ({ endpoint, fetchImpl: impl });

const listRequest = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

describe('relay', () => {
  it('forwards a request verbatim and returns the answer unaltered', async () => {
    const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
    const out = await relay(
      listRequest,
      deps(async (url, init) => {
        seen.push({ url, body: init.body, headers: init.headers });
        return ok('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      }),
    );
    expect(seen[0]?.url).toBe('https://www.fatstack.net/api/mcp');
    // Verbatim matters: the bridge must not re-serialise and quietly change a payload.
    expect(seen[0]?.body).toBe(listRequest);
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(out).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
  });

  it('answers a notification with nothing at all', async () => {
    const out = await relay(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      deps(async () => ok('{"jsonrpc":"2.0","id":null,"result":{}}')),
    );
    // Replying to a notification is a protocol error, even if the upstream replies to us.
    expect(out).toBeNull();
  });

  it('relays a 402 quote through untouched — it never mints or rewrites one', async () => {
    const quote =
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32002,"message":"Payment required: $0.005 USDC"}}';
    const out = await relay(
      '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x__y"}}',
      deps(async () => ({ ok: false, status: 402, text: async () => quote })),
    );
    expect(out).toBe(quote);
  });

  /*
   * The family rule. "I could not reach the catalogue" and "the catalogue is empty" must not
   * look alike to the client: one is worth retrying and the other is not.
   */
  it('reports an unreachable aggregator rather than an empty result', async () => {
    const out = await relay(
      listRequest,
      deps(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const parsed = JSON.parse(out ?? '{}');
    expect(parsed.error.code).toBe(RELAY_ERROR);
    expect(parsed.error.message).toContain('ECONNREFUSED');
    expect(parsed.id).toBe(1);
  });

  it('reports an empty-bodied HTTP error rather than returning nothing', async () => {
    const out = await relay(
      listRequest,
      deps(async () => ({ ok: false, status: 503, text: async () => '' })),
    );
    expect(JSON.parse(out ?? '{}').error.message).toContain('HTTP 503');
  });

  it('stays silent when a notification cannot be delivered', async () => {
    const out = await relay(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      deps(async () => {
        throw new Error('down');
      }),
    );
    expect(out).toBeNull();
  });

  it('rejects malformed JSON without crashing the process', async () => {
    const out = await relay(
      '{not json',
      deps(async () => ok('{}')),
    );
    expect(JSON.parse(out ?? '{}').error.message).toContain('malformed JSON');
  });

  it('rejects a well-formed object that is not JSON-RPC', async () => {
    const out = await relay(
      '{"hello":"world"}',
      deps(async () => ok('{}')),
    );
    expect(JSON.parse(out ?? '{}').error.message).toContain('not a JSON-RPC 2.0 message');
  });
});

describe('isNotification', () => {
  it('is decided by the absence of an id', () => {
    expect(isNotification({ jsonrpc: '2.0', method: 'x' })).toBe(true);
    expect(isNotification({ jsonrpc: '2.0', id: 0, method: 'x' })).toBe(false);
    // id 0 is a real id. Truthiness would misread it as a notification.
    expect(isNotification({ jsonrpc: '2.0', id: '', method: 'x' })).toBe(false);
  });
});

describe('env', () => {
  it('runs discovery-only with no wallet', () => {
    const env = envSchema.parse({});
    expect(canPay(env)).toBe(false);
    expect(env.FATSTACK_MCP_URL).toBe('https://www.fatstack.net/api/mcp');
  });

  it('refuses to start with a key and no daily ceiling', () => {
    const result = envSchema.safeParse({ FATSTACK_AGENT_KEY: `0x${'a'.repeat(64)}` });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues[0]?.message;
    expect(message).toContain('FATSTACK_MAX_PER_DAY is required');
    expect(message).toContain('payments are final');
  });

  it('accepts a key with a ceiling', () => {
    const env = envSchema.parse({
      FATSTACK_AGENT_KEY: `0x${'a'.repeat(64)}`,
      FATSTACK_MAX_PER_DAY: '0.50',
    });
    expect(canPay(env)).toBe(true);
    expect(env.FATSTACK_MAX_PER_DAY).toBe(0.5);
  });

  it('rejects a key that is not a 32-byte hex value', () => {
    expect(envSchema.safeParse({ FATSTACK_AGENT_KEY: 'hunter2' }).success).toBe(false);
  });

  it('rejects a network the catalogue does not serve', () => {
    expect(envSchema.safeParse({ FATSTACK_NETWORK: 'ethereum' }).success).toBe(false);
  });
});
