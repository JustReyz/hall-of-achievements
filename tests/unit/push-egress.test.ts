import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isPrivateOrBlockedIP,
  isAllowedPushOrigin,
  validatePushEndpoint,
  assertPushEndpointSafe,
  setAllowedTestOrigin,
  PushEgressError,
} from '@/lib/push/egress';

describe('Unit: Push Egress Security Engine (Anti-SSRF & Boundary Validation)', () => {
  beforeEach(() => {
    setAllowedTestOrigin(null);
  });

  afterEach(() => {
    setAllowedTestOrigin(null);
  });

  describe('IPv4 Blocklist Validation', () => {
    it('blocks loopback range 127.0.0.0/8', () => {
      expect(isPrivateOrBlockedIP('127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('127.0.0.2')).toBe(true);
      expect(isPrivateOrBlockedIP('127.255.255.254')).toBe(true);
    });

    it('blocks private range 10.0.0.0/8', () => {
      expect(isPrivateOrBlockedIP('10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('10.100.50.1')).toBe(true);
      expect(isPrivateOrBlockedIP('10.255.255.255')).toBe(true);
    });

    it('blocks private range 172.16.0.0/12', () => {
      expect(isPrivateOrBlockedIP('172.16.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('172.24.10.5')).toBe(true);
      expect(isPrivateOrBlockedIP('172.31.255.254')).toBe(true);
      // Non-private 172.x should not be blocked by 172.16.0.0/12 rule
      expect(isPrivateOrBlockedIP('172.15.255.255')).toBe(false);
      expect(isPrivateOrBlockedIP('172.32.0.1')).toBe(false);
    });

    it('blocks private range 192.168.0.0/16', () => {
      expect(isPrivateOrBlockedIP('192.168.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('192.168.1.100')).toBe(true);
      expect(isPrivateOrBlockedIP('192.168.255.254')).toBe(true);
    });

    it('blocks link-local range 169.254.0.0/16 and cloud metadata 169.254.169.254', () => {
      expect(isPrivateOrBlockedIP('169.254.1.1')).toBe(true);
      expect(isPrivateOrBlockedIP('169.254.169.254')).toBe(true); // AWS/GCP/Azure IMDS
    });

    it('blocks carrier-grade NAT 100.64.0.0/10', () => {
      expect(isPrivateOrBlockedIP('100.64.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('100.100.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('100.127.255.254')).toBe(true);
    });

    it('blocks 0.0.0.0/8, multicast 224.0.0.0/4, reserved 240.0.0.0/4, and broadcast 255.255.255.255', () => {
      expect(isPrivateOrBlockedIP('0.0.0.0')).toBe(true);
      expect(isPrivateOrBlockedIP('0.1.2.3')).toBe(true);
      expect(isPrivateOrBlockedIP('224.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('239.255.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('240.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('255.255.255.255')).toBe(true);
    });

    it('allows public, globally routable IPv4 addresses', () => {
      expect(isPrivateOrBlockedIP('8.8.8.8')).toBe(false);
      expect(isPrivateOrBlockedIP('1.1.1.1')).toBe(false);
      expect(isPrivateOrBlockedIP('142.250.190.46')).toBe(false); // Google
    });
  });

  describe('IPv6 Blocklist Validation', () => {
    it('blocks IPv6 loopback ::1', () => {
      expect(isPrivateOrBlockedIP('::1')).toBe(true);
      expect(isPrivateOrBlockedIP('[::1]')).toBe(true);
      expect(isPrivateOrBlockedIP('0:0:0:0:0:0:0:1')).toBe(true);
    });

    it('blocks IPv6 unspecified ::', () => {
      expect(isPrivateOrBlockedIP('::')).toBe(true);
      expect(isPrivateOrBlockedIP('0:0:0:0:0:0:0:0')).toBe(true);
    });

    it('blocks IPv6 unique local fc00::/7 (ULA)', () => {
      expect(isPrivateOrBlockedIP('fc00::1')).toBe(true);
      expect(isPrivateOrBlockedIP('fd12:3456:789a:1::1')).toBe(true);
    });

    it('blocks IPv6 link-local fe80::/10', () => {
      expect(isPrivateOrBlockedIP('fe80::1')).toBe(true);
      expect(isPrivateOrBlockedIP('fe80::200:5aee:feaa:20a2')).toBe(true);
    });

    it('blocks IPv6 multicast ff00::/8', () => {
      expect(isPrivateOrBlockedIP('ff02::1')).toBe(true);
      expect(isPrivateOrBlockedIP('ff05::2')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 addresses targeting private/loopback/metadata', () => {
      expect(isPrivateOrBlockedIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:192.168.1.1')).toBe(true);
    });

    it('allows public IPv6 addresses', () => {
      expect(isPrivateOrBlockedIP('2607:f8b0:4005:805::200e')).toBe(false); // Google IPv6
      expect(isPrivateOrBlockedIP('2606:4700:4700::1111')).toBe(false); // Cloudflare IPv6
    });
  });

  describe('Push Provider Origin Allowlist', () => {
    it('allows legitimate Google FCM hostnames', () => {
      expect(isAllowedPushOrigin('fcm.googleapis.com')).toBe(true);
      expect(isAllowedPushOrigin('android.googleapis.com')).toBe(true);
    });

    it('allows legitimate Apple APNs hostnames', () => {
      expect(isAllowedPushOrigin('push.apple.com')).toBe(true);
      expect(isAllowedPushOrigin('web.push.apple.com')).toBe(true);
      expect(isAllowedPushOrigin('gateway.push.apple.com')).toBe(true);
    });

    it('allows legitimate Mozilla Autopush hostnames', () => {
      expect(isAllowedPushOrigin('updates.push.services.mozilla.com')).toBe(true);
      expect(isAllowedPushOrigin('push.autopush.prod.mozaws.net')).toBe(true);
    });

    it('allows legitimate Microsoft WNS hostnames', () => {
      expect(isAllowedPushOrigin('notify.windows.com')).toBe(true);
      expect(isAllowedPushOrigin('wns2-sn1p.notify.windows.com')).toBe(true);
    });

    it('strictly rejects non-allowlisted hostnames and spoofing attempts', () => {
      expect(isAllowedPushOrigin('evil-attacker.com')).toBe(false);
      expect(isAllowedPushOrigin('push.apple.com.attacker.com')).toBe(false);
      expect(isAllowedPushOrigin('fcm.googleapis.com.fake.org')).toBe(false);
      expect(isAllowedPushOrigin('localhost')).toBe(false);
      expect(isAllowedPushOrigin('127.0.0.1')).toBe(false);
      expect(isAllowedPushOrigin('169.254.169.254')).toBe(false);
    });

    it('supports test hook for hermetic mock test servers', () => {
      setAllowedTestOrigin('https://127.0.0.1:9999');
      expect(isAllowedPushOrigin('127.0.0.1')).toBe(true);

      setAllowedTestOrigin(null);
      expect(isAllowedPushOrigin('127.0.0.1')).toBe(false);
    });
  });

  describe('Endpoint Structural & Protocol Validation', () => {
    it('rejects non-HTTPS protocol with INVALID_PROTOCOL', async () => {
      const res = await validatePushEndpoint('http://fcm.googleapis.com/fcm/send/test');
      expect(res.valid).toBe(false);
      expect(res.code).toBe('INVALID_PROTOCOL');
    });

    it('rejects explicit non-443 ports with INVALID_PORT', async () => {
      const res = await validatePushEndpoint('https://fcm.googleapis.com:8443/fcm/send/test');
      expect(res.valid).toBe(false);
      expect(res.code).toBe('INVALID_PORT');

      const resHttpPort = await validatePushEndpoint('https://fcm.googleapis.com:80/fcm/send/test');
      expect(resHttpPort.valid).toBe(false);
      expect(resHttpPort.code).toBe('INVALID_PORT');
    });

    it('rejects embedded credentials with USERINFO_DISALLOWED', async () => {
      const res = await validatePushEndpoint('https://admin:secret@fcm.googleapis.com/fcm/send/test');
      expect(res.valid).toBe(false);
      expect(res.code).toBe('USERINFO_DISALLOWED');
    });

    it('rejects endpoints exceeding 2048 characters with ENDPOINT_TOO_LONG', async () => {
      const longEndpoint = `https://fcm.googleapis.com/fcm/send/${'a'.repeat(2100)}`;
      const res = await validatePushEndpoint(longEndpoint);
      expect(res.valid).toBe(false);
      expect(res.code).toBe('ENDPOINT_TOO_LONG');
    });

    it('rejects malformed URLs with MALFORMED_URL', async () => {
      const res = await validatePushEndpoint('not-a-valid-url');
      expect(res.valid).toBe(false);
      expect(res.code).toBe('MALFORMED_URL');
    });

    it('assertPushEndpointSafe throws PushEgressError on invalid endpoint', async () => {
      await expect(
        assertPushEndpointSafe('http://fcm.googleapis.com/fcm/send/test')
      ).rejects.toThrow(PushEgressError);
    });
  });

  describe('Mock Test Origin Behavior', () => {
    it('allows mock test endpoint when test hook origin is configured', async () => {
      setAllowedTestOrigin('https://127.0.0.1:9876');
      const res = await validatePushEndpoint('https://127.0.0.1:9876/mock-push');
      expect(res.valid).toBe(true);
      expect(res.resolvedIps).toEqual(['127.0.0.1']);
    });
  });
});
