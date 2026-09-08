import { decodePaymentRequiredHeader } from '@x402/core/http';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { NO_REFUNDS_NOTICE, PAYMENT_REF_HEADER } from './constants.js';
import { honoPaywall } from './hono.js';
import { paywall } from './provider.js';
import { createMockFacilitator } from './testing.js';
import type { UnpaidBody } from './provider.js';

const WALLET = '0x1111111111111111111111111111111111111111';

const base = {
  price: '0.002',
  wallet: WALLET,
  toolId: 'sentiment',
  network: 'base' as const,
};

function appWith(overrides: Parameters<typeof paywall>[0]) {
  const gate = paywall(overrides);
  const app = new Hono();
  // Mounted exactly the way a provider would mount it.
  app.use('*', honoPaywall(gate));
  app.all('*', (c) => c.json({ result: 'the paid answer' }));
  return { app, gate };
}

describe('402 payment requirements', () => {
  it('quotes USDC on Base paid to the provider wallet, and says payments are final', async () => {
    const { app } = appWith({ ...base, facilitator: createMockFacilitator(), env: {} });
    const response = await app.request('https://sentiment.fatstack.net/run');

    expect(response.status).toBe(402);
    const body = (await response.json()) as UnpaidBody;

    expect(body.payTo).toBe(WALLET);
    expect(body.price.usdc).toBe('0.002');
    expect(body.price.amountAtomic).toBe('2000');
    expect(body.price.network).toBe('eip155:8453');
    expect(body.terms).toEqual({ refundable: false, notice: NO_REFUNDS_NOTICE });
    expect(body.message).toMatch(/no refunds/i);
    expect(body.docs).toMatch(/^https:\/\//);
  });

  it('advertises the provider wallet as payee in the x402 accepts block', async () => {
    const { gate } = appWith({ ...base, facilitator: createMockFacilitator(), env: {} });
    const accepts = gate.routeConfig.accepts;
    expect(Array.isArray(accepts) ? accepts[0]?.payTo : accepts.payTo).toBe(WALLET);
    expect(gate.payTo).toBe(WALLET);
  });
});

describe('EIP-712 domain in the quote', () => {
  // Regression. Without a signing domain the payer fails at payload creation, having
  // never reached a facilitator — so a mock facilitator cannot catch it. These assert the
  // decoded wire header, not the route config, because the route config looked correct
  // while the emitted requirements carried `extra: {}`.
  async function acceptsOf(network: 'base' | 'base-sepolia') {
    const { app } = appWith({
      ...base,
      network,
      facilitator: createMockFacilitator(),
      env: {},
    });
    const response = await app.request('https://sentiment.fatstack.net/run');
    const header = response.headers.get('payment-required');
    expect(header).toBeTruthy();
    return decodePaymentRequiredHeader(header as string).accepts;
  }

  it('publishes a signing domain a payer can actually use', async () => {
    const accepts = await acceptsOf('base');
    const extra = accepts[0]?.extra as { name?: string; version?: string } | undefined;
    expect(extra?.name).toBe('USD Coin');
    expect(extra?.version).toBe('2');
  });

  it('publishes the domain of the network it quotes, not a hardcoded one', async () => {
    // Mainnet USDC is "USD Coin"; the Sepolia deployment is "USDC". Signing against the
    // wrong name yields a signature the chain rejects.
    const extra = (await acceptsOf('base-sepolia'))[0]?.extra as { name?: string } | undefined;
    expect(extra?.name).toBe('USDC');
  });

  it('quotes the right asset and atomic amount on each network', async () => {
    const mainnet = (await acceptsOf('base'))[0];
    expect(mainnet?.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(mainnet?.amount).toBe('2000'); // $0.002 at 6 decimals

    const testnet = (await acceptsOf('base-sepolia'))[0];
    expect(testnet?.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(testnet?.payTo).toBe(WALLET);
  });
});

describe('killswitch', () => {
  it('takes the route offline with 503 and takes no payment', async () => {
    const facilitator = createMockFacilitator();
    const { app } = appWith({ ...base, facilitator, env: { KILLSWITCH: '1' } });
    const response = await app.request('https://sentiment.fatstack.net/run');

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('service_unavailable');
    expect(body.message).toMatch(/no payment was taken/i);
    expect(facilitator.verifyCalls).toBe(0);
    expect(facilitator.settleCalls).toBe(0);
  });
});

describe('fee mode', () => {
  const SPLITTER = '0xDfE85CEe968de2629b4444E6E4E19C289B123d92';

  it('defaults to direct, paying the provider with no platform cut', () => {
    const gate = paywall({ ...base, facilitator: createMockFacilitator(), env: {} });
    expect(gate.payTo).toBe(WALLET);
  });

  it('quotes the provider’s splitter under FEE_MODE=splitter', () => {
    const gate = paywall({
      ...base,
      facilitator: createMockFacilitator(),
      env: { FEE_MODE: 'splitter', SPLITTER_ADDRESS: SPLITTER },
    });
    expect(gate.payTo).toBe(SPLITTER);
  });

  it('refuses to start under FEE_MODE=splitter with no splitter address', () => {
    // The dangerous behaviour would be falling back to the wallet: the call would succeed,
    // the agent would pay, and the platform fee would be silently waived by a typo.
    expect(() =>
      paywall({ ...base, facilitator: createMockFacilitator(), env: { FEE_MODE: 'splitter' } }),
    ).toThrow(/splitter address/i);
  });

  async function bodyOf(env: Record<string, string>): Promise<UnpaidBody> {
    const { app } = appWith({ ...base, facilitator: createMockFacilitator(), env });
    const response = await app.request('https://sentiment.fatstack.net/run');
    expect(response.status).toBe(402);
    return (await response.json()) as UnpaidBody;
  }

  it('tells the agent how the payment settles, in both modes', async () => {
    const directBody = await bodyOf({});
    expect(directBody.settlement).toEqual({ via: 'direct', feeBps: 0 });
    expect(directBody.message).toMatch(/directly to the provider/i);

    const splitBody = await bodyOf({ FEE_MODE: 'splitter', SPLITTER_ADDRESS: SPLITTER });
    expect(splitBody.payTo).toBe(SPLITTER);
    expect(splitBody.settlement).toEqual({ via: 'splitter', feeBps: 200 });
    expect(splitBody.message).toMatch(/splitter/i);
    // The no-refunds notice is not optional on any payment surface.
    expect(splitBody.message).toMatch(/no refunds/i);
    expect(splitBody.terms.refundable).toBe(false);
  });

  it('advertises the splitter as payee in the x402 accepts block too', async () => {
    // The body is documentation; `accepts` is what the agent actually pays against. They
    // must not disagree about who receives the money.
    const { gate } = appWith({
      ...base,
      facilitator: createMockFacilitator(),
      env: { FEE_MODE: 'splitter', SPLITTER_ADDRESS: SPLITTER },
    });
    const accepts = gate.routeConfig.accepts;
    expect(Array.isArray(accepts) ? accepts[0]?.payTo : accepts.payTo).toBe(SPLITTER);
  });

  it('pays the provider’s own splitter when one is passed directly', () => {
    const gate = paywall({
      ...base,
      splitterAddress: SPLITTER,
      facilitator: createMockFacilitator(),
      env: { FEE_MODE: 'splitter' },
    });
    expect(gate.payTo).toBe(SPLITTER);
  });
});

describe('invalid payment', () => {
  it('does not settle when the facilitator rejects verification', async () => {
    const facilitator = createMockFacilitator({ invalidReason: 'insufficient_funds' });
    const { app } = appWith({ ...base, facilitator, env: {} });

    const response = await app.request('https://sentiment.fatstack.net/run', {
      headers: { 'X-PAYMENT': 'not-a-valid-payment-payload' },
    });

    expect(response.status).toBe(402);
    expect(facilitator.settleCalls).toBe(0);
    expect(response.headers.get(PAYMENT_REF_HEADER)).toBeNull();
  });

  it('rejects a malformed payment header without reaching the facilitator', async () => {
    const facilitator = createMockFacilitator();
    const { app } = appWith({ ...base, facilitator, env: {} });

    const response = await app.request('https://sentiment.fatstack.net/run', {
      headers: { 'X-PAYMENT': '!!!!not base64!!!!' },
    });

    expect(response.status).toBe(402);
    expect(facilitator.settleCalls).toBe(0);
  });
});

describe('expired requirements', () => {
  it('refuses a payment the facilitator reports as expired', async () => {
    const facilitator = createMockFacilitator({
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
    const { app } = appWith({ ...base, facilitator, env: {} });

    const payload = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: {
          signature: `0x${'ab'.repeat(65)}`,
          authorization: {
            from: '0x2222222222222222222222222222222222222222',
            to: WALLET,
            value: '2000',
            validAfter: '0',
            validBefore: '1',
            nonce: `0x${'11'.repeat(32)}`,
          },
        },
      }),
    ).toString('base64');

    const response = await app.request('https://sentiment.fatstack.net/run', {
      headers: { 'X-PAYMENT': payload },
    });

    expect(response.status).toBe(402);
    expect(facilitator.settleCalls).toBe(0);
  });
});
