import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as loginHandler } from '@/app/api/session/route';
import { resetDatabase, setSimulatedDbOutage } from '@/lib/db';
import { env } from '@/lib/env';

describe('Integration: Durable Rate Limiting & Abuse Prevention', () => {
  beforeEach(async () => {
    setSimulatedDbOutage(false);
    await resetDatabase();
  });

  afterEach(() => {
    setSimulatedDbOutage(false);
  });

  const validCode = env.OWNER_ACCESS_CODE;
  const wrongCode = 'invalid_access_code_32_characters_long_entropy!';

  function makeLoginRequest(headers: Record<string, string>, code: string = wrongCode) {
    return new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        origin: 'http://localhost:3000',
        ...headers,
      },
      body: JSON.stringify({ code }),
    });
  }

  it('triggers HTTP 429 on the 6th failed login attempt within 15 minutes', async () => {
    const ipHeaders = { 'x-vercel-forwarded-for': '198.51.100.99' };

    // Attempts 1 to 5 should return 401 Unauthorized with remaining count 4 -> 3 -> 2 -> 1 -> 0
    for (let i = 1; i <= 5; i++) {
      const res = await loginHandler(makeLoginRequest(ipHeaders));
      expect(res.status).toBe(401);
      const remaining = res.headers.get('x-ratelimit-remaining');
      expect(remaining).toBe(String(5 - i));
    }

    // 6th attempt must return 429 Too Many Requests with Retry-After header
    const res6 = await loginHandler(makeLoginRequest(ipHeaders));
    expect(res6.status).toBe(429);

    const body = (await res6.json()) as { error: string; retryAfter: number };
    expect(body.error).toContain('Too many failed attempts');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(900); // 15 minutes max

    const retryAfterHeader = res6.headers.get('retry-after');
    expect(retryAfterHeader).toBeTruthy();
    expect(Number(retryAfterHeader)).toBe(body.retryAfter);

    // 7th attempt should also be immediately blocked with 429
    const res7 = await loginHandler(makeLoginRequest(ipHeaders));
    expect(res7.status).toBe(429);
  });

  it('protects against spoofed X-Forwarded-For headers', async () => {
    const trustedIp = '203.0.113.77';

    // Attacker tries to bypass rate limiting by cycling fake X-Forwarded-For headers
    // but the trusted platform header x-vercel-forwarded-for remains 203.0.113.77
    for (let i = 1; i <= 5; i++) {
      const spoofedHeaders = {
        'x-vercel-forwarded-for': trustedIp,
        'x-forwarded-for': `10.0.0.${i}, 192.168.1.${i}`,
      };
      const res = await loginHandler(makeLoginRequest(spoofedHeaders));
      expect(res.status).toBe(401);
    }

    // 6th attempt with another spoofed header should be blocked with 429
    const spoofedHeaders6 = {
      'x-vercel-forwarded-for': trustedIp,
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
    };
    const res6 = await loginHandler(makeLoginRequest(spoofedHeaders6));
    expect(res6.status).toBe(429);
  });

  it('maintains independent rate limit buckets per client IP', async () => {
    const ipHeadersA = { 'x-vercel-forwarded-for': '198.51.100.101' };
    const ipHeadersB = { 'x-vercel-forwarded-for': '198.51.100.102' };

    // Block IP A with 5 failed attempts
    for (let i = 1; i <= 5; i++) {
      await loginHandler(makeLoginRequest(ipHeadersA));
    }

    // Verify IP A is blocked
    const resA = await loginHandler(makeLoginRequest(ipHeadersA));
    expect(resA.status).toBe(429);

    // Verify IP B is unaffected and can attempt login normally
    const resB = await loginHandler(makeLoginRequest(ipHeadersB));
    expect(resB.status).toBe(401); // 401, NOT 429
  });

  it('successful login does not increment failed rate limit counter', async () => {
    const ipHeaders = { 'x-vercel-forwarded-for': '198.51.100.150' };

    // 3 failed attempts
    for (let i = 1; i <= 3; i++) {
      const res = await loginHandler(makeLoginRequest(ipHeaders, wrongCode));
      expect(res.status).toBe(401);
    }

    // 1 successful login
    const successRes = await loginHandler(makeLoginRequest(ipHeaders, validCode));
    expect(successRes.status).toBe(200);

    // Another failed attempt should be attempt #4, NOT #5 (not 429)
    const afterSuccessRes = await loginHandler(makeLoginRequest(ipHeaders, wrongCode));
    expect(afterSuccessRes.status).toBe(401);
  });

  it('fails closed with HTTP 503 when database encounters an outage', async () => {
    const ipHeaders = { 'x-vercel-forwarded-for': '198.51.100.200' };

    // Simulate database outage / disconnect
    setSimulatedDbOutage(true);

    // Both valid and invalid credentials MUST fail closed with 503
    const resFail = await loginHandler(makeLoginRequest(ipHeaders, validCode));
    expect(resFail.status).toBe(503);

    const body = (await resFail.json()) as { error: string };
    expect(body.error).toBe('Authentication service unavailable');
  });
});
