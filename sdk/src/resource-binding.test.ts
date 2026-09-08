import { describe, expect, it } from 'vitest';

import { checkResourceBinding, resourceMismatchBody } from './resource-binding.js';

/**
 * Class 3 regression — cross-resource free-riding.
 *
 * Reproduced live on Base Sepolia on 2026-09-03: a fresh authorisation minted for
 * `adversarial-tool-a` was verified, settled and served by `adversarial-tool-b`, because
 * two tools from one provider at one price quote byte-identical requirements and nothing
 * checked the resource the payer actually signed for.
 */
const header = (resource: unknown): string =>
  Buffer.from(JSON.stringify({ x402Version: 2, resource }), 'utf8').toString('base64');

describe('class 3 — resource binding', () => {
  it('accepts a payment made for the URL being called', () => {
    const value = header({ url: 'https://echo.fatstack.net/mcp' });
    expect(checkResourceBinding(value, 'https://echo.fatstack.net/mcp').ok).toBe(true);
  });

  it('refuses an authorization minted for a sibling tool', () => {
    const value = header({ url: 'https://tool-a.fatstack.net/run' });
    const result = checkResourceBinding(value, 'https://tool-b.fatstack.net/run');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('resource_mismatch');
  });

  it('refuses a different route on the same host', () => {
    const value = header({ url: 'https://tool.fatstack.net/cheap' });
    expect(checkResourceBinding(value, 'https://tool.fatstack.net/expensive').ok).toBe(false);
  });

  it('ignores query strings, which are not part of what was purchased', () => {
    const value = header({ url: 'https://tool.fatstack.net/run?a=1' });
    expect(checkResourceBinding(value, 'https://tool.fatstack.net/run?b=2').ok).toBe(true);
  });

  it('treats a trailing slash as the same resource', () => {
    const value = header({ url: 'https://tool.fatstack.net/run/' });
    expect(checkResourceBinding(value, 'https://tool.fatstack.net/run').ok).toBe(true);
  });

  it('compares the host case-insensitively', () => {
    const value = header({ url: 'https://Tool.Fatstack.NET/run' });
    expect(checkResourceBinding(value, 'https://tool.fatstack.net/run').ok).toBe(true);
  });

  it('distinguishes ports, so two local tools are not interchangeable', () => {
    // Exactly the shape the live reproduction had: same host, different port.
    const value = header({ url: 'http://localhost:8821/run' });
    expect(checkResourceBinding(value, 'http://localhost:8822/run').ok).toBe(false);
  });

  it('lets a request with no payment header through to the normal path', () => {
    expect(checkResourceBinding(null, 'https://tool.fatstack.net/run').ok).toBe(true);
  });

  it('defers a malformed header to the real verifier rather than inventing a reason', () => {
    // A payment we cannot decode is malformed, not misdirected. Rejecting it here would
    // report the wrong cause for the same fault.
    expect(checkResourceBinding('not-base64-at-all', 'https://tool.fatstack.net/run').ok).toBe(
      true,
    );
  });

  it('allows a payload that carries no resource at all', () => {
    // Older clients may omit it. The amount, payee, asset and network checks still apply,
    // so this is a narrower payment rather than an unchecked one.
    expect(checkResourceBinding(header(undefined), 'https://tool.fatstack.net/run').ok).toBe(true);
  });

  it('explains the refusal without echoing the signature', () => {
    const value = header({ url: 'https://tool-a.fatstack.net/run' });
    const body = resourceMismatchBody(
      checkResourceBinding(value, 'https://tool-b.fatstack.net/run'),
    );
    expect(JSON.stringify(body)).not.toMatch(/signature|0x[0-9a-f]{64}/i);
    expect(body.message).toMatch(/no payment was taken/i);
  });
});
