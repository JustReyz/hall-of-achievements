import net from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';

let allowedTestOrigin: string | null = null;

/**
 * Configure an allowed test origin for hermetic mock test servers.
 */
export function setAllowedTestOrigin(origin: string | null) {
  allowedTestOrigin = origin;
}

export function getAllowedTestOrigin(): string | null {
  return allowedTestOrigin;
}

export class PushEgressError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PushEgressError';
    this.code = code;
  }
}

/**
 * Parses IPv4 address string into a 32-bit unsigned integer.
 */
export function ipv4ToNumber(ip: string): number {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  const p0 = parts[0];
  const p1 = parts[1];
  const p2 = parts[2];
  const p3 = parts[3];
  if (
    parts.length !== 4 ||
    p0 === undefined ||
    p1 === undefined ||
    p2 === undefined ||
    p3 === undefined ||
    isNaN(p0) ||
    isNaN(p1) ||
    isNaN(p2) ||
    isNaN(p3) ||
    p0 < 0 ||
    p0 > 255 ||
    p1 < 0 ||
    p1 > 255 ||
    p2 < 0 ||
    p2 > 255 ||
    p3 < 0 ||
    p3 > 255
  ) {
    throw new PushEgressError('Invalid IPv4 address format', 'MALFORMED_IP');
  }
  return ((p0 << 24) | (p1 << 16) | (p2 << 8) | p3) >>> 0;
}

/**
 * Checks if an IPv4 address falls into private, loopback, link-local, carrier-grade NAT,
 * multicast, reserved, or cloud metadata ranges.
 */
export function isPrivateOrBlockedIPv4(ip: string): boolean {
  let num: number;
  try {
    num = ipv4ToNumber(ip);
  } catch {
    return true;
  }

  const firstOctet = (num >>> 24) & 0xff;
  const secondOctet = (num >>> 16) & 0xff;

  // 0.0.0.0/8 (Current network)
  if (firstOctet === 0) return true;

  // 10.0.0.0/8 (RFC 1918 Private)
  if (firstOctet === 10) return true;

  // 100.64.0.0/10 (Shared Address Space / CGNAT: 100.64.0.0 - 100.127.255.255)
  if (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) return true;

  // 127.0.0.0/8 (Loopback)
  if (firstOctet === 127) return true;

  // 169.254.0.0/16 (Link-Local & Cloud Metadata 169.254.169.254)
  if (firstOctet === 169 && secondOctet === 254) return true;

  // 172.16.0.0/12 (RFC 1918 Private: 172.16.0.0 - 172.31.255.255)
  if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (firstOctet === 192 && secondOctet === 0 && ((num >>> 8) & 0xff) === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1 documentation)
  if (firstOctet === 192 && secondOctet === 0 && ((num >>> 8) & 0xff) === 2) return true;

  // 192.168.0.0/16 (RFC 1918 Private)
  if (firstOctet === 192 && secondOctet === 168) return true;

  // 198.18.0.0/15 (Benchmarking: 198.18.0.0 - 198.19.255.255)
  if (firstOctet === 198 && (secondOctet === 18 || secondOctet === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2 documentation)
  if (firstOctet === 198 && secondOctet === 51 && ((num >>> 8) & 0xff) === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3 documentation)
  if (firstOctet === 203 && secondOctet === 0 && ((num >>> 8) & 0xff) === 113) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (firstOctet >= 224 && firstOctet <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future Use: 240.0.0.0 - 255.255.255.254)
  if (firstOctet >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (num === 0xffffffff) return true;

  return false;
}

/**
 * Parses an IPv6 string into 8 16-bit integer hextets (0x0000 - 0xffff).
 * Handles brackets, zero-compression (::), and embedded dotted IPv4 quad suffixes.
 * Returns null if the address is malformed.
 */
export function parseIPv6ToHextets(ip: string): number[] | null {
  let clean = ip.replace(/^\[|\]$/g, '').toLowerCase().trim();

  // 1. Handle embedded IPv4 dotted-decimal suffix (e.g., ::ffff:192.168.1.1 or ::127.0.0.1)
  const lastColon = clean.lastIndexOf(':');
  if (lastColon !== -1) {
    const lastPart = clean.slice(lastColon + 1);
    if (lastPart.includes('.')) {
      const octets = lastPart.split('.');
      if (octets.length !== 4) return null;
      const nums = octets.map((o) => {
        if (!/^\d{1,3}$/.test(o)) return NaN;
        const n = parseInt(o, 10);
        return n >= 0 && n <= 255 ? n : NaN;
      });
      if (nums.some((n) => isNaN(n))) return null;
      const h1 = (((nums[0]! << 8) | nums[1]!) >>> 0).toString(16);
      const h2 = (((nums[2]! << 8) | nums[3]!) >>> 0).toString(16);
      clean = clean.slice(0, lastColon + 1) + h1 + ':' + h2;
    }
  }

  // 2. Enforce RFC 4291: "::" can appear at most once
  const doubleColonMatches = clean.match(/::/g);
  if (doubleColonMatches && doubleColonMatches.length > 1) return null;

  let parts: string[];
  if (doubleColonMatches && doubleColonMatches.length === 1) {
    const splitResult = clean.split('::');
    const left = splitResult[0] ?? '';
    const right = splitResult[1] ?? '';
    const leftParts = left === '' ? [] : left.split(':');
    const rightParts = right === '' ? [] : right.split(':');

    // Reject invalid consecutive colons like ":::1" or "1:::2"
    if (leftParts.some((p) => p === '') || rightParts.some((p) => p === '')) {
      return null;
    }

    const present = leftParts.length + rightParts.length;
    if (present > 7) return null; // "::" must expand at least one 16-bit word

    const zerosNeeded = 8 - present;
    parts = [...leftParts, ...Array(zerosNeeded).fill('0'), ...rightParts];
  } else {
    parts = clean.split(':');
    if (parts.length !== 8) return null;
  }

  if (parts.length !== 8) return null;

  // 3. Parse each hextet into a 16-bit integer
  const words: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    const val = parseInt(p, 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    words.push(val);
  }

  return words;
}

/**
 * Checks if an IPv6 address falls into loopback, unspecified, unique-local,
 * link-local, multicast, discard, documentation, benchmarking, teredo,
 * 6to4 private, NAT64, or IPv4-mapped blocked ranges.
 */
export function isPrivateOrBlockedIPv6(ip: string): boolean {
  const words = parseIPv6ToHextets(ip);
  if (!words) {
    // Malformed or unparseable IPv6 fails closed
    return true;
  }

  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // 1. Loopback ::1/128 (RFC 4291)
  // First 7 hextets are 0, hextet 7 is 1 (matches ::1, ::0001, 0::1, fully expanded)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) {
    return true;
  }

  // 2. Unspecified ::/128 (RFC 4291)
  // All 8 hextets are 0 (matches ::, ::0, 0::0, fully expanded)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 0) {
    return true;
  }

  // 3. IPv4-mapped IPv6 ::ffff:0:0/96 (RFC 4291 §2.5.5.2)
  // Hextets 0-4 are 0, hextet 5 is 0xffff; extract embedded 32-bit IPv4 from w6 & w7
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    const embeddedV4 = `${(w6! >> 8) & 0xff}.${w6! & 0xff}.${(w7! >> 8) & 0xff}.${w7! & 0xff}`;
    return isPrivateOrBlockedIPv4(embeddedV4);
  }

  // 4. IPv4-compatible IPv6 ::0:0/96 (RFC 4291 §2.5.5.1, deprecated)
  // Hextets 0-5 are 0; extract embedded 32-bit IPv4 from w6 & w7
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    const embeddedV4 = `${(w6! >> 8) & 0xff}.${w6! & 0xff}.${(w7! >> 8) & 0xff}.${w7! & 0xff}`;
    return isPrivateOrBlockedIPv4(embeddedV4);
  }

  // 5. 6to4 Tunneling 2002::/16 (RFC 3056)
  // w0 === 0x2002; embedded 32-bit IPv4 is in bits 16-47 (w1 & w2)
  if (w0 === 0x2002) {
    const embeddedV4 = `${(w1! >> 8) & 0xff}.${w1! & 0xff}.${(w2! >> 8) & 0xff}.${w2! & 0xff}`;
    return isPrivateOrBlockedIPv4(embeddedV4);
  }

  // 6. NAT64 Well-Known Prefix 64:ff9b::/96 (RFC 6052) & Local-Use 64:ff9b:1::/48 (RFC 8215)
  if (w0 === 0x0064 && w1 === 0xff9b) {
    // If Well-Known Prefix (w2-w5 are 0), check embedded IPv4 in w6 & w7
    if (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
      const embeddedV4 = `${(w6! >> 8) & 0xff}.${w6! & 0xff}.${(w7! >> 8) & 0xff}.${w7! & 0xff}`;
      if (isPrivateOrBlockedIPv4(embeddedV4)) return true;
    }
    // Block all 64:ff9b::/96 and 64:ff9b:1::/48 as non-globally-routable translation prefixes
    return true;
  }

  // 7. Unique Local Address (ULA) fc00::/7 (RFC 4193)
  // Exact bitmask: (w0 & 0xfe00) === 0xfc00 (covers fc00:: through fdff::)
  if ((w0! & 0xfe00) === 0xfc00) {
    return true;
  }

  // 8. Link-Local Unicast fe80::/10 (RFC 4291)
  // Exact bitmask: (w0 & 0xffc0) === 0xfe80 (covers fe80:: through febf::)
  if ((w0! & 0xffc0) === 0xfe80) {
    return true;
  }

  // 9. Multicast ff00::/8 (RFC 4291)
  // (w0 >> 8) === 0xff (covers ff00:: through ffff::)
  if ((w0! >> 8) === 0xff) {
    return true;
  }

  // 10. Discard prefix 100::/64 (RFC 6666)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) {
    return true;
  }

  // 11. Documentation 2001:db8::/32 (RFC 3849)
  if (w0 === 0x2001 && w1 === 0x0db8) {
    return true;
  }

  // 12. Benchmarking 2001:2::/48 (RFC 5180)
  if (w0 === 0x2001 && w1 === 0x0002 && w2 === 0) {
    return true;
  }

  // 13. Teredo Tunneling 2001:0000::/32 (RFC 4380)
  if (w0 === 0x2001 && w1 === 0x0000) {
    return true;
  }

  // 14. Deprecated Site-Local Unicast fec0::/10 (RFC 3879)
  if ((w0! & 0xffc0) === 0xfec0) {
    return true;
  }

  return false;
}

/**
 * Validates any IP address (IPv4 or IPv6) against forbidden/private ranges.
 */
export function isPrivateOrBlockedIP(ip: string): boolean {
  // Strip bracket wrappers from IPv6 if present: [::1] -> ::1
  const cleanIp = ip.replace(/^\[|\]$/g, '').trim();
  if (net.isIPv4(cleanIp)) {
    return isPrivateOrBlockedIPv4(cleanIp);
  }
  if (net.isIPv6(cleanIp) || cleanIp.includes(':')) {
    return isPrivateOrBlockedIPv6(cleanIp);
  }
  // Unknown or unparseable format -> fail safe
  return true;
}

/**
 * Checks whether a hostname matches the push provider origin allowlist.
 */
export function isAllowedPushOrigin(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Test hook check for mock test servers
  if (allowedTestOrigin) {
    try {
      const testUrl = new URL(allowedTestOrigin);
      if (h === testUrl.hostname.toLowerCase()) return true;
    } catch {
      if (h === allowedTestOrigin.toLowerCase()) return true;
    }
  }

  // Google FCM
  if (h === 'fcm.googleapis.com' || h === 'android.googleapis.com') {
    return true;
  }

  // Apple APNs
  if (h === 'push.apple.com' || h.endsWith('.push.apple.com')) {
    return true;
  }

  // Mozilla Autopush
  if (h === 'updates.push.services.mozilla.com' || h.endsWith('.autopush.prod.mozaws.net')) {
    return true;
  }

  // Microsoft Windows Push (WNS)
  if (h === 'notify.windows.com' || h.endsWith('.notify.windows.com')) {
    return true;
  }

  return false;
}

export interface PushEndpointValidationResult {
  valid: boolean;
  url?: URL;
  resolvedIps?: string[];
  error?: string;
  code?: string;
}

/**
 * Validates a Web Push endpoint URL for SSRF security:
 * 1. HTTPS only
 * 2. Port 443 only (or empty/default)
 * 3. No credentials/userinfo
 * 4. Max 2048 characters
 * 5. Allowlisted push provider origins
 * 6. Non-private, non-loopback, non-metadata IP addresses via DNS
 */
export async function validatePushEndpoint(endpoint: string): Promise<PushEndpointValidationResult> {
  if (!endpoint || typeof endpoint !== 'string') {
    return { valid: false, error: 'Endpoint must be a non-empty string', code: 'INVALID_ENDPOINT' };
  }

  if (endpoint.length > 2048) {
    return { valid: false, error: 'Endpoint exceeds maximum length of 2048 characters', code: 'ENDPOINT_TOO_LONG' };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { valid: false, error: 'Invalid endpoint URL format', code: 'MALFORMED_URL' };
  }

  // Test hook handling for mock test servers
  const isTestServer =
    allowedTestOrigin &&
    (parsed.origin.toLowerCase() === allowedTestOrigin.toLowerCase() ||
      parsed.hostname.toLowerCase() === new URL(allowedTestOrigin).hostname.toLowerCase());

  if (!isTestServer) {
    // Protocol must be HTTPS
    if (parsed.protocol !== 'https:') {
      return {
        valid: false,
        error: 'Push endpoints must use HTTPS protocol',
        code: 'INVALID_PROTOCOL',
      };
    }

    // Port must be empty or default 443
    if (parsed.port && parsed.port !== '443') {
      return {
        valid: false,
        error: `Push endpoints must use default HTTPS port 443. Explicit port ${parsed.port} is rejected.`,
        code: 'INVALID_PORT',
      };
    }
  }

  // Must not have userinfo credentials
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: 'Push endpoints must not include embedded credentials',
      code: 'USERINFO_DISALLOWED',
    };
  }

  // Origin / Hostname check
  if (!isAllowedPushOrigin(parsed.hostname)) {
    return {
      valid: false,
      error: `Push endpoint hostname '${parsed.hostname}' is not an authorized Web Push provider`,
      code: 'INVALID_PUSH_PROVIDER',
    };
  }

  // In test mode matching mock test origin, bypass DNS check
  if (isTestServer) {
    return {
      valid: true,
      url: parsed,
      resolvedIps: ['127.0.0.1'],
    };
  }

  // DNS resolution & IP validation
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true });
  } catch (err) {
    return {
      valid: false,
      error: `Failed to resolve push endpoint hostname '${parsed.hostname}': ${(err as Error).message}`,
      code: 'DNS_RESOLUTION_FAILED',
    };
  }

  if (!addresses || addresses.length === 0) {
    return {
      valid: false,
      error: `No IP addresses found for hostname '${parsed.hostname}'`,
      code: 'DNS_NO_RECORDS',
    };
  }

  const resolvedIps = addresses.map((a) => a.address);

  for (const resolvedIp of resolvedIps) {
    if (isPrivateOrBlockedIP(resolvedIp)) {
      return {
        valid: false,
        error: `Push endpoint '${parsed.hostname}' resolved to blocked private or link-local IP '${resolvedIp}'`,
        code: 'SSRF_DETECTED',
        resolvedIps,
      };
    }
  }

  return {
    valid: true,
    url: parsed,
    resolvedIps,
  };
}

/**
 * Asserts that a push endpoint is safe. Throws PushEgressError on failure.
 */
export async function assertPushEndpointSafe(
  endpoint: string
): Promise<{ url: URL; resolvedIps: string[] }> {
  const result = await validatePushEndpoint(endpoint);
  if (!result.valid || !result.url || !result.resolvedIps) {
    throw new PushEgressError(result.error || 'Push endpoint failed egress validation', result.code || 'EGRESS_VIOLATION');
  }
  return { url: result.url, resolvedIps: result.resolvedIps };
}

/**
 * Creates an HTTPS/HTTP Agent pinned to a validated IP address to defeat DNS rebinding (TOCTOU).
 */
export function createSafePushAgent(pinnedIp: string, targetHostname: string, isHttp = false): https.Agent | http.Agent {
  const cleanIp = pinnedIp.replace(/^\[|\]$/g, '');
  const isV4 = net.isIPv4(cleanIp);

  if (isHttp) {
    return new http.Agent({
      lookup: (_hostname, _options, callback) => {
        callback(null, cleanIp, isV4 ? 4 : 6);
      },
      timeout: 10000,
    });
  }

  return new https.Agent({
    lookup: (_hostname, _options, callback) => {
      callback(null, cleanIp, isV4 ? 4 : 6);
    },
    servername: targetHostname, // Retain TLS Server Name Indication (SNI)
    timeout: 10000,
  });
}
