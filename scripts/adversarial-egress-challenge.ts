/**
 * Empirical Adversarial Test Harness for SSRF Egress and Network Validation Engine
 * Target: src/lib/push/egress.ts
 *
 * Runs comprehensive attacks across IPv4 variations, IPv6 variations,
 * protocol schemes, ports, embedded credentials, origin spoofing, and DNS rebinding/poisoning.
 */

import dns from 'node:dns';
import https from 'node:https';
import {
  isPrivateOrBlockedIP,
  isAllowedPushOrigin,
  validatePushEndpoint,
  createSafePushAgent,
} from '../src/lib/push/egress';

interface TestResult {
  category: string;
  vector: string;
  input: string;
  expected: 'BLOCKED' | 'ALLOWED' | 'ERROR';
  actual: 'BLOCKED' | 'ALLOWED' | 'ERROR';
  passed: boolean;
  notes?: string | undefined;
}

const results: TestResult[] = [];

function record(
  category: string,
  vector: string,
  input: string,
  expected: 'BLOCKED' | 'ALLOWED' | 'ERROR',
  actual: 'BLOCKED' | 'ALLOWED' | 'ERROR',
  notes?: string
) {
  const passed = expected === actual;
  const entry: TestResult = { category, vector, input, expected, actual, passed };
  if (notes !== undefined) {
    entry.notes = notes;
  }
  results.push(entry);
}

// ----------------------------------------------------------------------
// 1. IPv4 Blocklist and Representation Attacks
// ----------------------------------------------------------------------
console.log('--- 1. Testing IPv4 Blocklist and Variations ---');

const ipv4TestCases = [
  // Standard Loopback 127.0.0.0/8
  { ip: '127.0.0.1', expected: 'BLOCKED', desc: 'Standard loopback' },
  { ip: '127.0.0.2', expected: 'BLOCKED', desc: 'Loopback range' },
  { ip: '127.255.255.254', expected: 'BLOCKED', desc: 'Loopback upper boundary' },

  // Private RFC 1918 10.0.0.0/8
  { ip: '10.0.0.1', expected: 'BLOCKED', desc: 'RFC 1918 10.0.0.0/8 start' },
  { ip: '10.254.254.254', expected: 'BLOCKED', desc: 'RFC 1918 10.0.0.0/8 body' },
  { ip: '10.255.255.255', expected: 'BLOCKED', desc: 'RFC 1918 10.0.0.0/8 broadcast' },

  // Link-Local & AWS/GCP/Azure IMDS 169.254.0.0/16
  { ip: '169.254.169.254', expected: 'BLOCKED', desc: 'Cloud Metadata IMDS' },
  { ip: '169.254.1.1', expected: 'BLOCKED', desc: 'Link-Local 169.254.0.0/16' },
  { ip: '169.254.255.255', expected: 'BLOCKED', desc: 'Link-Local broadcast' },

  // Current network 0.0.0.0/8
  { ip: '0.0.0.0', expected: 'BLOCKED', desc: 'Unspecified IPv4' },
  { ip: '0.1.2.3', expected: 'BLOCKED', desc: 'Current network 0.0.0.0/8' },

  // Private RFC 1918 172.16.0.0/12
  { ip: '172.16.0.1', expected: 'BLOCKED', desc: 'RFC 1918 172.16.0.0/12 lower' },
  { ip: '172.31.255.254', expected: 'BLOCKED', desc: 'RFC 1918 172.16.0.0/12 upper' },
  { ip: '172.15.255.255', expected: 'ALLOWED', desc: 'RFC 1918 172.16.0.0/12 lower boundary neighbor (public)' },
  { ip: '172.32.0.1', expected: 'ALLOWED', desc: 'RFC 1918 172.16.0.0/12 upper boundary neighbor (public)' },

  // Private RFC 1918 192.168.0.0/16
  { ip: '192.168.0.1', expected: 'BLOCKED', desc: 'RFC 1918 192.168.0.0/16 lower' },
  { ip: '192.168.1.100', expected: 'BLOCKED', desc: 'RFC 1918 192.168.0.0/16 body' },
  { ip: '192.168.255.254', expected: 'BLOCKED', desc: 'RFC 1918 192.168.0.0/16 upper' },

  // CGNAT 100.64.0.0/10
  { ip: '100.64.0.1', expected: 'BLOCKED', desc: 'CGNAT lower' },
  { ip: '100.127.255.254', expected: 'BLOCKED', desc: 'CGNAT upper' },
  { ip: '100.63.255.255', expected: 'ALLOWED', desc: 'CGNAT lower boundary neighbor (public)' },
  { ip: '100.128.0.1', expected: 'ALLOWED', desc: 'CGNAT upper boundary neighbor (public)' },

  // Special / Documentation / Benchmark ranges
  { ip: '192.0.2.1', expected: 'BLOCKED', desc: 'TEST-NET-1 (RFC 5737)' },
  { ip: '198.51.100.1', expected: 'BLOCKED', desc: 'TEST-NET-2 (RFC 5737)' },
  { ip: '203.0.113.1', expected: 'BLOCKED', desc: 'TEST-NET-3 (RFC 5737)' },
  { ip: '198.18.0.1', expected: 'BLOCKED', desc: 'Benchmarking 198.18.0.0/15' },
  { ip: '224.0.0.1', expected: 'BLOCKED', desc: 'Multicast 224.0.0.0/4' },
  { ip: '240.0.0.1', expected: 'BLOCKED', desc: 'Reserved 240.0.0.0/4' },
  { ip: '255.255.255.255', expected: 'BLOCKED', desc: 'Broadcast' },

  // Legitimate Public IPv4
  { ip: '8.8.8.8', expected: 'ALLOWED', desc: 'Public DNS (Google)' },
  { ip: '1.1.1.1', expected: 'ALLOWED', desc: 'Public DNS (Cloudflare)' },
  { ip: '142.250.190.46', expected: 'ALLOWED', desc: 'Public Google IP' },

  // Alternate IP representations (Octal, Hex, Decimal)
  { ip: '0177.0.0.1', expected: 'BLOCKED', desc: 'Octal 127.0.0.1' },
  { ip: '012.0.0.1', expected: 'BLOCKED', desc: 'Octal 10.0.0.1' },
  { ip: '0251.0376.0251.0376', expected: 'BLOCKED', desc: 'Octal 169.254.169.254' },
  { ip: '0x7f000001', expected: 'BLOCKED', desc: 'Dword hex 127.0.0.1' },
  { ip: '0x7f.0.0.1', expected: 'BLOCKED', desc: 'Mixed hex 127.0.0.1' },
  { ip: '0xa000001', expected: 'BLOCKED', desc: 'Dword hex 10.0.0.1' },
  { ip: '0xa9fea9fe', expected: 'BLOCKED', desc: 'Dword hex 169.254.169.254' },
  { ip: '2130706433', expected: 'BLOCKED', desc: 'Decimal integer 127.0.0.1' },
  { ip: '2852039166', expected: 'BLOCKED', desc: 'Decimal integer 169.254.169.254' },
  { ip: '167772161', expected: 'BLOCKED', desc: 'Decimal integer 10.0.0.1' },

  // Malformed / Partial IPv4
  { ip: '127.1', expected: 'BLOCKED', desc: 'BSD 2-part IP' },
  { ip: '10.1', expected: 'BLOCKED', desc: 'BSD 2-part IP' },
  { ip: '127.0.0.1.1', expected: 'BLOCKED', desc: '5-part IP' },
  { ip: '999.999.999.999', expected: 'BLOCKED', desc: 'Out of range octets' },
  { ip: '-1.0.0.1', expected: 'BLOCKED', desc: 'Negative octet' },
  { ip: '127.0.0.abc', expected: 'BLOCKED', desc: 'Alphanumeric octet' },
];

for (const t of ipv4TestCases) {
  const isBlocked = isPrivateOrBlockedIP(t.ip);
  record(
    'IPv4',
    t.desc,
    t.ip,
    t.expected as any,
    isBlocked ? 'BLOCKED' : 'ALLOWED'
  );
}

// ----------------------------------------------------------------------
// 2. IPv6 Blocklist and Variation Attacks
// ----------------------------------------------------------------------
console.log('--- 2. Testing IPv6 Blocklist and Variations ---');

const ipv6TestCases = [
  // Loopback ::1 variations
  { ip: '::1', expected: 'BLOCKED', desc: 'Standard IPv6 loopback' },
  { ip: '[::1]', expected: 'BLOCKED', desc: 'Bracketed IPv6 loopback' },
  { ip: '0:0:0:0:0:0:0:1', expected: 'BLOCKED', desc: 'Expanded loopback' },
  { ip: '::0001', expected: 'BLOCKED', desc: 'Zero-padded loopback ::0001' },
  { ip: '0::1', expected: 'BLOCKED', desc: 'Alternate compressed loopback 0::1' },
  { ip: '0000:0000:0000:0000:0000:0000:0000:0001', expected: 'BLOCKED', desc: 'Fully expanded 32-hex loopback' },

  // Unspecified :: variations
  { ip: '::', expected: 'BLOCKED', desc: 'Standard IPv6 unspecified' },
  { ip: '[::]', expected: 'BLOCKED', desc: 'Bracketed IPv6 unspecified' },
  { ip: '0:0:0:0:0:0:0:0', expected: 'BLOCKED', desc: 'Expanded unspecified' },
  { ip: '::0', expected: 'BLOCKED', desc: 'Alternate unspecified ::0' },
  { ip: '0::0', expected: 'BLOCKED', desc: 'Alternate unspecified 0::0' },
  { ip: '0000:0000:0000:0000:0000:0000:0000:0000', expected: 'BLOCKED', desc: 'Fully expanded 32-hex unspecified' },

  // Unique Local Address fc00::/7
  { ip: 'fc00::1', expected: 'BLOCKED', desc: 'ULA fc00::1' },
  { ip: 'fd00::1', expected: 'BLOCKED', desc: 'ULA fd00::1' },
  { ip: 'fd12:3456:789a:1::1', expected: 'BLOCKED', desc: 'ULA fd12:...' },

  // Link-Local fe80::/10
  { ip: 'fe80::1', expected: 'BLOCKED', desc: 'Link-Local fe80::1' },
  { ip: 'fe80::200:5aee:feaa:20a2', expected: 'BLOCKED', desc: 'Link-Local with EUI-64' },
  { ip: 'fe90::1', expected: 'BLOCKED', desc: 'Link-Local fe90::1 (in fe80::/10)' },
  { ip: 'fea0::1', expected: 'BLOCKED', desc: 'Link-Local fea0::1 (in fe80::/10)' },
  { ip: 'feb0::1', expected: 'BLOCKED', desc: 'Link-Local feb0::1 (in fe80::/10)' },
  { ip: 'febf::1', expected: 'BLOCKED', desc: 'Link-Local upper boundary' },

  // Multicast ff00::/8
  { ip: 'ff02::1', expected: 'BLOCKED', desc: 'All-nodes multicast ff02::1' },
  { ip: 'ff05::2', expected: 'BLOCKED', desc: 'Site-local multicast ff05::2' },

  // Discard & Documentation
  { ip: '100::1', expected: 'BLOCKED', desc: 'Discard prefix 100::/64' },
  { ip: '0100::1', expected: 'BLOCKED', desc: 'Discard prefix 0100::1' },
  { ip: '2001:db8::1', expected: 'BLOCKED', desc: 'Documentation 2001:db8::/32' },
  { ip: '2001:0db8::1', expected: 'BLOCKED', desc: 'Documentation 2001:0db8::1' },

  // NAT64 64:ff9b::/96
  { ip: '64:ff9b::1', expected: 'BLOCKED', desc: 'NAT64 prefix 64:ff9b::1' },
  { ip: '0064:ff9b::1', expected: 'BLOCKED', desc: 'NAT64 prefix zero-padded 0064:ff9b::1' },

  // 6to4 Tunneling 2002::/16 embedding private IPv4
  { ip: '2002:7f00:0001::', expected: 'BLOCKED', desc: '6to4 embedding 127.0.0.1' },
  { ip: '2002:a9fe:a9fe::', expected: 'BLOCKED', desc: '6to4 embedding 169.254.169.254' },
  { ip: '2002:0a00:0001::', expected: 'BLOCKED', desc: '6to4 embedding 10.0.0.1' },

  // IPv4-mapped IPv6 (Dotted Decimal)
  { ip: '::ffff:127.0.0.1', expected: 'BLOCKED', desc: 'IPv4-mapped 127.0.0.1 (dotted)' },
  { ip: '::ffff:169.254.169.254', expected: 'BLOCKED', desc: 'IPv4-mapped IMDS (dotted)' },
  { ip: '::ffff:10.0.0.1', expected: 'BLOCKED', desc: 'IPv4-mapped 10.0.0.1 (dotted)' },
  { ip: '::ffff:192.168.1.1', expected: 'BLOCKED', desc: 'IPv4-mapped 192.168.1.1 (dotted)' },
  { ip: '::ffff:172.16.0.1', expected: 'BLOCKED', desc: 'IPv4-mapped 172.16.0.1 (dotted)' },
  { ip: '0:0:0:0:0:ffff:127.0.0.1', expected: 'BLOCKED', desc: 'Expanded IPv4-mapped 127.0.0.1 (dotted)' },

  // IPv4-mapped IPv6 (Hexadecimal Notation)
  { ip: '::ffff:7f00:0001', expected: 'BLOCKED', desc: 'IPv4-mapped 127.0.0.1 (hex 7f00:0001)' },
  { ip: '::ffff:7f00:1', expected: 'BLOCKED', desc: 'IPv4-mapped 127.0.0.1 (hex 7f00:1)' },
  { ip: '::ffff:a9fe:a9fe', expected: 'BLOCKED', desc: 'IPv4-mapped IMDS 169.254.169.254 (hex a9fe:a9fe)' },
  { ip: '::ffff:0a00:0001', expected: 'BLOCKED', desc: 'IPv4-mapped 10.0.0.1 (hex 0a00:0001)' },
  { ip: '::ffff:c0a8:0101', expected: 'BLOCKED', desc: 'IPv4-mapped 192.168.1.1 (hex c0a8:0101)' },
  { ip: '0:0:0:0:0:ffff:7f00:1', expected: 'BLOCKED', desc: 'Expanded IPv4-mapped 127.0.0.1 (hex)' },

  // Legitimate Public IPv6
  { ip: '2607:f8b0:4005:805::200e', expected: 'ALLOWED', desc: 'Public Google IPv6' },
  { ip: '2606:4700:4700::1111', expected: 'ALLOWED', desc: 'Public Cloudflare IPv6' },
];

for (const t of ipv6TestCases) {
  const isBlocked = isPrivateOrBlockedIP(t.ip);
  record(
    'IPv6',
    t.desc,
    t.ip,
    t.expected as any,
    isBlocked ? 'BLOCKED' : 'ALLOWED'
  );
}

// ----------------------------------------------------------------------
// 3. Origin Allowlist Validation Attacks
// ----------------------------------------------------------------------
console.log('--- 3. Testing Origin Allowlist and Spoofing ---');

const originTestCases = [
  // Allowed providers
  { host: 'fcm.googleapis.com', expected: 'ALLOWED', desc: 'Google FCM primary' },
  { host: 'android.googleapis.com', expected: 'ALLOWED', desc: 'Google FCM android' },
  { host: 'push.apple.com', expected: 'ALLOWED', desc: 'Apple APNs primary' },
  { host: 'web.push.apple.com', expected: 'ALLOWED', desc: 'Apple APNs web push' },
  { host: 'gateway.push.apple.com', expected: 'ALLOWED', desc: 'Apple APNs gateway' },
  { host: 'updates.push.services.mozilla.com', expected: 'ALLOWED', desc: 'Mozilla Autopush primary' },
  { host: 'push.autopush.prod.mozaws.net', expected: 'ALLOWED', desc: 'Mozilla Autopush mozaws' },
  { host: 'notify.windows.com', expected: 'ALLOWED', desc: 'Microsoft WNS primary' },
  { host: 'wns2-sn1p.notify.windows.com', expected: 'ALLOWED', desc: 'Microsoft WNS subdomain' },

  // Spoofed & Disallowed Origins
  { host: 'evil.com', expected: 'BLOCKED', desc: 'Generic attacker domain' },
  { host: 'push.apple.com.attacker.com', expected: 'BLOCKED', desc: 'Subdomain prefix spoofing Apple' },
  { host: 'fcm.googleapis.com.evil.org', expected: 'BLOCKED', desc: 'Subdomain prefix spoofing FCM' },
  { host: 'evil-fcm.googleapis.com', expected: 'BLOCKED', desc: 'Hyphenated spoofing FCM' },
  { host: 'fakeapple.com', expected: 'BLOCKED', desc: 'Typosquatting Apple' },
  { host: 'localhost', expected: 'BLOCKED', desc: 'Localhost name' },
  { host: '127.0.0.1', expected: 'BLOCKED', desc: 'Direct loopback IP' },
  { host: '169.254.169.254', expected: 'BLOCKED', desc: 'Direct IMDS IP' },
  { host: 'metadata.google.internal', expected: 'BLOCKED', desc: 'GCP metadata internal DNS' },
  { host: 'push.apple.com:8443', expected: 'BLOCKED', desc: 'Hostname with port injection' },
];

for (const t of originTestCases) {
  const allowed = isAllowedPushOrigin(t.host);
  record(
    'Origin',
    t.desc,
    t.host,
    t.expected as any,
    allowed ? 'ALLOWED' : 'BLOCKED'
  );
}

// ----------------------------------------------------------------------
// 4. URL Structural, Protocol, Port, and Credential Validation
// ----------------------------------------------------------------------
console.log('--- 4. Testing URL Protocol, Port, Credentials, and Length ---');

async function runEndpointTests() {
  const endpointTestCases = [
    // Protocols
    { url: 'http://fcm.googleapis.com/fcm/send/test', expected: 'BLOCKED', desc: 'Insecure HTTP protocol', code: 'INVALID_PROTOCOL' },
    { url: 'ftp://fcm.googleapis.com/test', expected: 'BLOCKED', desc: 'FTP protocol', code: 'INVALID_PROTOCOL' },
    { url: 'file:///etc/passwd', expected: 'BLOCKED', desc: 'File protocol', code: 'INVALID_PROTOCOL' },
    { url: 'gopher://127.0.0.1:70/', expected: 'BLOCKED', desc: 'Gopher protocol', code: 'INVALID_PROTOCOL' },
    { url: 'ws://fcm.googleapis.com/socket', expected: 'BLOCKED', desc: 'WebSocket ws:// protocol', code: 'INVALID_PROTOCOL' },
    { url: 'wss://fcm.googleapis.com/socket', expected: 'BLOCKED', desc: 'WebSocket wss:// protocol', code: 'INVALID_PROTOCOL' },

    // Ports
    { url: 'https://fcm.googleapis.com:443/fcm/send/test', expected: 'ALLOWED', desc: 'Explicit port 443' },
    { url: 'https://fcm.googleapis.com:80/fcm/send/test', expected: 'BLOCKED', desc: 'Disallowed HTTP port 80', code: 'INVALID_PORT' },
    { url: 'https://fcm.googleapis.com:8080/fcm/send/test', expected: 'BLOCKED', desc: 'Disallowed alt port 8080', code: 'INVALID_PORT' },
    { url: 'https://fcm.googleapis.com:8443/fcm/send/test', expected: 'BLOCKED', desc: 'Disallowed alt port 8443', code: 'INVALID_PORT' },
    { url: 'https://fcm.googleapis.com:22/fcm/send/test', expected: 'BLOCKED', desc: 'Disallowed SSH port 22', code: 'INVALID_PORT' },

    // Embedded user credentials
    { url: 'https://user:password@fcm.googleapis.com/fcm/send/test', expected: 'BLOCKED', desc: 'Embedded username:password', code: 'USERINFO_DISALLOWED' },
    { url: 'https://admin@fcm.googleapis.com/fcm/send/test', expected: 'BLOCKED', desc: 'Embedded username only', code: 'USERINFO_DISALLOWED' },
    { url: 'https://:secret@fcm.googleapis.com/fcm/send/test', expected: 'BLOCKED', desc: 'Embedded password only', code: 'USERINFO_DISALLOWED' },

    // Length limit (2048)
    { url: `https://fcm.googleapis.com/fcm/send/${'a'.repeat(2000)}`, expected: 'ALLOWED', desc: 'Length <= 2048 chars' },
    { url: `https://fcm.googleapis.com/fcm/send/${'a'.repeat(2100)}`, expected: 'BLOCKED', desc: 'Length > 2048 chars (2135)', code: 'ENDPOINT_TOO_LONG' },

    // Malformed URLs
    { url: '', expected: 'BLOCKED', desc: 'Empty endpoint', code: 'INVALID_ENDPOINT' },
    { url: '   ', expected: 'BLOCKED', desc: 'Whitespace endpoint', code: 'MALFORMED_URL' },
    { url: 'not-a-url', expected: 'BLOCKED', desc: 'Non-URL string', code: 'MALFORMED_URL' },
    { url: 'https://', expected: 'BLOCKED', desc: 'Scheme only', code: 'MALFORMED_URL' },
  ];

  for (const t of endpointTestCases) {
    let actual: 'BLOCKED' | 'ALLOWED' = 'BLOCKED';
    let errCode: string | undefined;

    // Use setAllowedTestOrigin to prevent external live DNS calls during protocol/port testing
    // if target origin is test, but test default without it:
    const res = await validatePushEndpoint(t.url);
    if (res.valid) {
      actual = 'ALLOWED';
    } else {
      actual = 'BLOCKED';
      errCode = res.code;
    }

    record(
      'Endpoint',
      t.desc,
      t.url.length > 60 ? t.url.substring(0, 50) + '...' : t.url,
      t.expected as any,
      actual,
      errCode ? `code: ${errCode}` : undefined
    );
  }
}

// ----------------------------------------------------------------------
// 5. DNS Resolution & Rebinding (TOCTOU) Attacks
// ----------------------------------------------------------------------
console.log('--- 5. Testing DNS Resolution SSRF & Rebinding Attacks ---');

async function runDnsRebindingTests() {
  const originalLookup = dns.promises.lookup;

  const dnsScenarios = [
    {
      desc: 'Allowed FCM domain resolving to loopback 127.0.0.1',
      resolvedIps: ['127.0.0.1'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to cloud metadata 169.254.169.254',
      resolvedIps: ['169.254.169.254'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to private 10.0.0.1',
      resolvedIps: ['10.0.0.1'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to IPv6 loopback ::1',
      resolvedIps: ['::1'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to dotted IPv4-mapped loopback ::ffff:127.0.0.1',
      resolvedIps: ['::ffff:127.0.0.1'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to hex IPv4-mapped loopback ::ffff:7f00:1',
      resolvedIps: ['::ffff:7f00:1'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to hex IPv4-mapped IMDS ::ffff:a9fe:a9fe',
      resolvedIps: ['::ffff:a9fe:a9fe'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to zero-padded IPv6 loopback ::0001',
      resolvedIps: ['::0001'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to compressed IPv6 loopback 0::1',
      resolvedIps: ['0::1'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to mixed IPs [public 142.250.190.46, private 127.0.0.1]',
      resolvedIps: ['142.250.190.46', '127.0.0.1'],
      expected: 'BLOCKED',
    },
    {
      desc: 'Allowed FCM domain resolving to legitimate public IP 142.250.190.46',
      resolvedIps: ['142.250.190.46'],
      expected: 'ALLOWED',
    },
  ];

  for (const s of dnsScenarios) {
    dns.promises.lookup = (async () => {
      return s.resolvedIps.map((ip) => ({
        address: ip,
        family: ip.includes(':') ? 6 : 4,
      }));
    }) as any;

    const res = await validatePushEndpoint('https://fcm.googleapis.com/fcm/send/test');
    record(
      'DNS-Rebinding',
      s.desc,
      JSON.stringify(s.resolvedIps),
      s.expected as any,
      res.valid ? 'ALLOWED' : 'BLOCKED',
      res.error ? res.error : undefined
    );
  }

  // Test DNS resolution failure
  dns.promises.lookup = (async () => {
    throw new Error('ENOTFOUND fake error');
  }) as any;

  const dnsFailRes = await validatePushEndpoint('https://fcm.googleapis.com/fcm/send/test');
  record(
    'DNS-Rebinding',
    'DNS lookup throws error (fails safe)',
    'ENOTFOUND',
    'BLOCKED',
    dnsFailRes.valid ? 'ALLOWED' : 'BLOCKED',
    dnsFailRes.code
  );

  // Test DNS empty records
  dns.promises.lookup = (async () => {
    return [];
  }) as any;

  const dnsEmptyRes = await validatePushEndpoint('https://fcm.googleapis.com/fcm/send/test');
  record(
    'DNS-Rebinding',
    'DNS lookup returns empty records (fails safe)',
    '[]',
    'BLOCKED',
    dnsEmptyRes.valid ? 'ALLOWED' : 'BLOCKED',
    dnsEmptyRes.code
  );

  // Restore DNS lookup
  dns.promises.lookup = originalLookup;
}

// ----------------------------------------------------------------------
// 6. Safe Socket Agent Verification
// ----------------------------------------------------------------------
console.log('--- 6. Testing Safe Socket Agent (createSafePushAgent) ---');

function runSafeAgentTests() {
  const agent = createSafePushAgent('142.250.190.46', 'fcm.googleapis.com') as https.Agent;
  const isAgent = agent instanceof https.Agent;
  record('Agent', 'Agent instance creation', '142.250.190.46', 'ALLOWED', isAgent ? 'ALLOWED' : 'BLOCKED');

  // Verify lookup pins to pre-validated IP
  let pinnedIpResolved: string | null = null;
  const lookupFn = (agent as any).options?.lookup;
  if (typeof lookupFn === 'function') {
    lookupFn('any-attacker-hostname.com', {}, (_err: any, address: string) => {
      pinnedIpResolved = address;
    });
  }
  record(
    'Agent',
    'Socket lookup callback pins to pre-validated IP',
    'any-attacker-hostname.com',
    'ALLOWED',
    pinnedIpResolved === '142.250.190.46' ? 'ALLOWED' : 'BLOCKED',
    `Pinned to: ${pinnedIpResolved}`
  );

  // Verify SNI servername preserved
  const servername = (agent as any).options?.servername;
  record(
    'Agent',
    'SNI servername matches target hostname for TLS',
    'fcm.googleapis.com',
    'ALLOWED',
    servername === 'fcm.googleapis.com' ? 'ALLOWED' : 'BLOCKED',
    `SNI: ${servername}`
  );
}

// ----------------------------------------------------------------------
// Execution and Reporting
// ----------------------------------------------------------------------
async function main() {
  await runEndpointTests();
  await runDnsRebindingTests();
  runSafeAgentTests();

  console.log('\n======================================================================');
  console.log('EMIRICAL ADVERSARIAL CHALLENGE TEST RESULTS');
  console.log('======================================================================');

  let passedCount = 0;
  let failedCount = 0;
  const failures: TestResult[] = [];

  for (const r of results) {
    if (r.passed) {
      passedCount++;
      console.log(`[PASS] [${r.category}] ${r.vector}: ${r.input} => ${r.actual}`);
    } else {
      failedCount++;
      failures.push(r);
      console.error(`[FAIL] [${r.category}] ${r.vector}: ${r.input}`);
      console.error(`       Expected: ${r.expected}, Actual: ${r.actual} ${r.notes ? `(${r.notes})` : ''}`);
    }
  }

  console.log('======================================================================');
  console.log(`TOTAL TESTS: ${results.length} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
  console.log('======================================================================\n');

  if (failures.length > 0) {
    console.error(`CRITICAL VULNERABILITIES DETECTED: ${failures.length} test cases failed!`);
    for (const f of failures) {
      console.error(`- [${f.category}] ${f.vector}: input="${f.input}", expected=${f.expected}, actual=${f.actual}`);
    }
    process.exitCode = 1;
  } else {
    console.log('ALL EMPIRICAL ADVERSARIAL CHECKS PASSED.');
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
