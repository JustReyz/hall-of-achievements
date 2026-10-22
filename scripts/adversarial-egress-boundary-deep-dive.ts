/**
 * Empirical Adversarial Boundary Deep Dive Harness for SSRF Egress Validation
 * Target: src/lib/push/egress.ts
 *
 * Exhaustively stress-tests:
 * - Scope/Zone IDs (%eth0, %1, etc.)
 * - 6to4 Tunneling edge cases (2002::/16)
 * - NAT64 edge cases (64:ff9b::/96 and 64:ff9b:1::/48)
 * - IPv4-mapped & IPv4-compatible variations (dotted, hex, expanded, mixed case)
 * - Obfuscated IPv4 representations (octal, hex, dword, mixed)
 * - Extended zero compression and expansion variations
 * - Syntax violations and malformed IP strings (fail-closed check)
 * - URL boundary cases (2048 vs 2049 chars, userinfo tricks, punycode/IDN spoofing)
 * - DNS rebinding with mixed A and AAAA records
 * - Agent pinning & SNI retention
 */

import dns from 'node:dns';
import {
  isPrivateOrBlockedIP,
  validatePushEndpoint,
  createSafePushAgent,
} from '../src/lib/push/egress';

interface DeepDiveResult {
  category: string;
  vector: string;
  input: string;
  expected: 'BLOCKED' | 'ALLOWED' | 'NULL' | 'PARSED';
  actual: 'BLOCKED' | 'ALLOWED' | 'NULL' | 'PARSED';
  passed: boolean;
  details?: string | undefined;
}

const results: DeepDiveResult[] = [];

function check(
  category: string,
  vector: string,
  input: string,
  expected: 'BLOCKED' | 'ALLOWED' | 'NULL' | 'PARSED',
  actual: 'BLOCKED' | 'ALLOWED' | 'NULL' | 'PARSED',
  details?: string
) {
  const passed = expected === actual;
  const entry: DeepDiveResult = { category, vector, input, expected, actual, passed };
  if (details !== undefined) {
    entry.details = details;
  }
  results.push(entry);
  if (!passed) {
    console.error(`FAILED: ${category} - ${vector}: input="${input}", expected=${expected}, actual=${actual}`);
  }
}

async function runBoundaryDeepDive() {
  console.log('======================================================================');
  console.log('STARTING EMPIRICAL ADVERSARIAL BOUNDARY DEEP DIVE');
  console.log('======================================================================\n');

  // ----------------------------------------------------------------------
  // 1. Scope / Zone ID Handling (%eth0, %1, etc.)
  // ----------------------------------------------------------------------
  console.log('--- 1. Scope / Zone IDs on IPv6 ---');
  const zoneIdCases = [
    { ip: 'fe80::1%eth0', desc: 'Link-local with interface name' },
    { ip: 'fe80::1%1', desc: 'Link-local with numeric zone ID' },
    { ip: '[fe80::1%eth0]', desc: 'Bracketed link-local with interface name' },
    { ip: '::1%lo', desc: 'Loopback with interface lo' },
    { ip: '::1%1', desc: 'Loopback with numeric zone ID' },
    { ip: '[::1%lo]', desc: 'Bracketed loopback with interface lo' },
    { ip: 'fc00::1%eth0', desc: 'ULA with interface' },
    { ip: '2607:f8b0:4005:805::200e%eth0', desc: 'Public IPv6 with zone ID (invalid in egress)' },
  ];

  for (const tc of zoneIdCases) {
    // All scoped IP addresses must fail closed (BLOCKED) for egress security
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('Zone IDs', tc.desc, tc.ip, 'BLOCKED', isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 2. 6to4 Tunneling Boundary Cases (2002::/16)
  // ----------------------------------------------------------------------
  console.log('--- 2. 6to4 Tunneling Boundary Edge Cases ---');
  const sixToFourCases = [
    // Loopback 127.0.0.1 -> 7f00:0001
    { ip: '2002:7f00:0001::', expected: 'BLOCKED', desc: '6to4 embedding 127.0.0.1' },
    { ip: '2002:7f00:1::', expected: 'BLOCKED', desc: '6to4 embedding 127.0.0.1 shortened' },
    { ip: '2002:7f00:0001:0000:0000:0000:0000:0000', expected: 'BLOCKED', desc: '6to4 embedding 127.0.0.1 expanded' },
    { ip: '2002:7F00:0001::', expected: 'BLOCKED', desc: '6to4 embedding 127.0.0.1 uppercase' },
    { ip: '2002:7f00:0001::1234', expected: 'BLOCKED', desc: '6to4 embedding 127.0.0.1 with host ID' },

    // Cloud Metadata 169.254.169.254 -> a9fe:a9fe
    { ip: '2002:a9fe:a9fe::', expected: 'BLOCKED', desc: '6to4 embedding IMDS' },
    { ip: '2002:A9FE:A9FE::', expected: 'BLOCKED', desc: '6to4 embedding IMDS uppercase' },
    { ip: '2002:a9fe:a9fe:ffff::1', expected: 'BLOCKED', desc: '6to4 embedding IMDS with SLA/host' },

    // RFC 1918 10.0.0.1 -> 0a00:0001
    { ip: '2002:0a00:0001::', expected: 'BLOCKED', desc: '6to4 embedding 10.0.0.1' },
    { ip: '2002:a00:1::', expected: 'BLOCKED', desc: '6to4 embedding 10.0.0.1 trimmed zeros' },

    // RFC 1918 172.16.0.1 -> ac10:0001
    { ip: '2002:ac10:0001::', expected: 'BLOCKED', desc: '6to4 embedding 172.16.0.1' },
    { ip: '2002:ac1f:ffff::', expected: 'BLOCKED', desc: '6to4 embedding 172.31.255.255 upper RFC1918' },

    // RFC 1918 192.168.1.1 -> c0a8:0101
    { ip: '2002:c0a8:0101::', expected: 'BLOCKED', desc: '6to4 embedding 192.168.1.1' },

    // CGNAT 100.64.0.1 -> 6440:0001
    { ip: '2002:6440:0001::', expected: 'BLOCKED', desc: '6to4 embedding CGNAT 100.64.0.1' },

    // Current network 0.0.0.0 -> 0000:0000
    { ip: '2002::', expected: 'BLOCKED', desc: '6to4 prefix only (0.0.0.0)' },
    { ip: '2002:0000:0000::', expected: 'BLOCKED', desc: '6to4 explicit 0.0.0.0' },
    { ip: '2002::1', expected: 'BLOCKED', desc: '6to4 with 0.0.0.0 embedded and host 1' },

    // Multicast 224.0.0.1 -> e000:0001
    { ip: '2002:e000:0001::', expected: 'BLOCKED', desc: '6to4 embedding multicast' },

    // Broadcast 255.255.255.255 -> ffff:ffff
    { ip: '2002:ffff:ffff::', expected: 'BLOCKED', desc: '6to4 embedding broadcast' },

    // Legitimate Public IPv4 in 6to4
    { ip: '2002:0808:0808::', expected: 'ALLOWED', desc: '6to4 embedding Google DNS 8.8.8.8' },
    { ip: '2002:808:808::', expected: 'ALLOWED', desc: '6to4 embedding 8.8.8.8 trimmed' },
    { ip: '2002:0101:0101::', expected: 'ALLOWED', desc: '6to4 embedding Cloudflare 1.1.1.1' },
  ];

  for (const tc of sixToFourCases) {
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('6to4 Tunneling', tc.desc, tc.ip, tc.expected as any, isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 3. NAT64 Edge Cases (64:ff9b::/96 and 64:ff9b:1::/48)
  // ----------------------------------------------------------------------
  console.log('--- 3. NAT64 Boundary Edge Cases ---');
  const nat64Cases = [
    { ip: '64:ff9b::127.0.0.1', expected: 'BLOCKED', desc: 'NAT64 WKP with dotted loopback' },
    { ip: '64:ff9b::169.254.169.254', expected: 'BLOCKED', desc: 'NAT64 WKP with dotted IMDS' },
    { ip: '64:ff9b::10.0.0.1', expected: 'BLOCKED', desc: 'NAT64 WKP with dotted RFC 1918' },
    { ip: '64:ff9b::8.8.8.8', expected: 'BLOCKED', desc: 'NAT64 WKP with public IP (all NAT64 blocked)' },
    { ip: '64:ff9b::7f00:1', expected: 'BLOCKED', desc: 'NAT64 WKP hex loopback' },
    { ip: '64:FF9B::1', expected: 'BLOCKED', desc: 'NAT64 WKP uppercase' },
    { ip: '0064:ff9b::1', expected: 'BLOCKED', desc: 'NAT64 WKP zero-padded prefix' },
    { ip: '64:ff9b::', expected: 'BLOCKED', desc: 'NAT64 WKP base prefix 64:ff9b::' },
    { ip: '64:ff9b:1::', expected: 'BLOCKED', desc: 'NAT64 Local-Use prefix start' },
    { ip: '64:ff9b:1::1', expected: 'BLOCKED', desc: 'NAT64 Local-Use with host 1' },
    { ip: '0064:ff9b:0001::abcd', expected: 'BLOCKED', desc: 'NAT64 Local-Use zero-padded' },
    { ip: '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'NAT64 Local-Use upper boundary' },
  ];

  for (const tc of nat64Cases) {
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('NAT64 Boundary', tc.desc, tc.ip, tc.expected as any, isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 4. IPv4-Mapped and IPv4-Compatible Variations
  // ----------------------------------------------------------------------
  console.log('--- 4. IPv4-Mapped & IPv4-Compatible Edge Cases ---');
  const mappedAndCompatibleCases = [
    // IPv4-mapped (::ffff:0:0/96)
    { ip: '::ffff:127.0.0.1', expected: 'BLOCKED', desc: 'IPv4-mapped dotted loopback' },
    { ip: '::FFFF:127.0.0.1', expected: 'BLOCKED', desc: 'IPv4-mapped uppercase FFFF dotted loopback' },
    { ip: '::FfFf:127.0.0.1', expected: 'BLOCKED', desc: 'IPv4-mapped mixed case FfFf' },
    { ip: '0000:0000:0000:0000:0000:ffff:127.0.0.1', expected: 'BLOCKED', desc: 'IPv4-mapped fully expanded dotted' },
    { ip: '0:0:0:0:0:ffff:7f00:0001', expected: 'BLOCKED', desc: 'IPv4-mapped expanded hex loopback' },
    { ip: '::ffff:7f00:1', expected: 'BLOCKED', desc: 'IPv4-mapped compressed hex loopback' },
    { ip: '::ffff:7f00:0001', expected: 'BLOCKED', desc: 'IPv4-mapped compressed hex 4-digit loopback' },
    { ip: '::ffff:a9fe:a9fe', expected: 'BLOCKED', desc: 'IPv4-mapped hex IMDS' },
    { ip: '::ffff:0a00:0001', expected: 'BLOCKED', desc: 'IPv4-mapped hex 10.0.0.1' },
    { ip: '::ffff:c0a8:0101', expected: 'BLOCKED', desc: 'IPv4-mapped hex 192.168.1.1' },
    { ip: '::ffff:ac10:0001', expected: 'BLOCKED', desc: 'IPv4-mapped hex 172.16.0.1' },
    { ip: '::ffff:6440:0001', expected: 'BLOCKED', desc: 'IPv4-mapped hex CGNAT 100.64.0.1' },
    { ip: '::ffff:0:0', expected: 'BLOCKED', desc: 'IPv4-mapped 0.0.0.0' },
    { ip: '::ffff:ffff:ffff', expected: 'BLOCKED', desc: 'IPv4-mapped 255.255.255.255' },

    // Legitimate public IPv4-mapped
    { ip: '::ffff:8.8.8.8', expected: 'ALLOWED', desc: 'IPv4-mapped public 8.8.8.8 dotted' },
    { ip: '::ffff:0808:0808', expected: 'ALLOWED', desc: 'IPv4-mapped public 8.8.8.8 hex' },
    { ip: '::ffff:1.1.1.1', expected: 'ALLOWED', desc: 'IPv4-mapped public 1.1.1.1 dotted' },
    { ip: '::ffff:0101:0101', expected: 'ALLOWED', desc: 'IPv4-mapped public 1.1.1.1 hex' },

    // IPv4-compatible (::0:0/96, deprecated)
    { ip: '::127.0.0.1', expected: 'BLOCKED', desc: 'IPv4-compatible dotted loopback' },
    { ip: '::169.254.169.254', expected: 'BLOCKED', desc: 'IPv4-compatible dotted IMDS' },
    { ip: '::10.0.0.1', expected: 'BLOCKED', desc: 'IPv4-compatible dotted 10.0.0.1' },
    { ip: '::192.168.1.1', expected: 'BLOCKED', desc: 'IPv4-compatible dotted 192.168.1.1' },
    { ip: '::172.16.0.1', expected: 'BLOCKED', desc: 'IPv4-compatible dotted 172.16.0.1' },
    { ip: '::7f00:0001', expected: 'BLOCKED', desc: 'IPv4-compatible hex loopback' },
    { ip: '::7f00:1', expected: 'BLOCKED', desc: 'IPv4-compatible hex loopback short' },
    { ip: '::a9fe:a9fe', expected: 'BLOCKED', desc: 'IPv4-compatible hex IMDS' },
    { ip: '::0a00:0001', expected: 'BLOCKED', desc: 'IPv4-compatible hex 10.0.0.1' },
    { ip: '::c0a8:0101', expected: 'BLOCKED', desc: 'IPv4-compatible hex 192.168.1.1' },
    { ip: '::ac10:0001', expected: 'BLOCKED', desc: 'IPv4-compatible hex 172.16.0.1' },
    { ip: '0:0:0:0:0:0:127.0.0.1', expected: 'BLOCKED', desc: 'IPv4-compatible expanded dotted loopback' },
    { ip: '0000:0000:0000:0000:0000:0000:7f00:0001', expected: 'BLOCKED', desc: 'IPv4-compatible expanded hex loopback' },

    // Legitimate public IPv4-compatible
    { ip: '::8.8.8.8', expected: 'ALLOWED', desc: 'IPv4-compatible public 8.8.8.8 dotted' },
    { ip: '::0808:0808', expected: 'ALLOWED', desc: 'IPv4-compatible public 8.8.8.8 hex' },
    { ip: '::1.1.1.1', expected: 'ALLOWED', desc: 'IPv4-compatible public 1.1.1.1 dotted' },
    { ip: '::0101:0101', expected: 'ALLOWED', desc: 'IPv4-compatible public 1.1.1.1 hex' },
  ];

  for (const tc of mappedAndCompatibleCases) {
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('Mapped/Compatible', tc.desc, tc.ip, tc.expected as any, isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 5. Special RFC Ranges & Boundary Bitmasks
  // ----------------------------------------------------------------------
  console.log('--- 5. Special RFC IPv6 Ranges & Boundaries ---');
  const specialRfcCases = [
    // ULA fc00::/7 (covers fc00:: through fdff:ffff:...)
    { ip: 'fc00::', expected: 'BLOCKED', desc: 'ULA lowest boundary fc00::' },
    { ip: 'fc00::1', expected: 'BLOCKED', desc: 'ULA fc00::1' },
    { ip: 'fd00::1', expected: 'BLOCKED', desc: 'ULA fd00::1' },
    { ip: 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'ULA upper boundary fdff:...' },
    // ULA neighbor check: fbff:ffff:... should NOT match ULA
    { ip: 'fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', expected: 'ALLOWED', desc: 'ULA lower neighbor fbff:... (not blocked)' },
    // fe00:: is not ULA, but let's check fe80:: (link-local)
    { ip: 'fe80::', expected: 'BLOCKED', desc: 'Link-local lowest boundary fe80::' },
    { ip: 'fe80::1', expected: 'BLOCKED', desc: 'Link-local fe80::1' },
    { ip: 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'Link-local upper boundary febf:...' },
    // Link-local upper neighbor fec0::/10 is deprecated site-local unicast (RFC 3879), also blocked
    { ip: 'fec0::1', expected: 'BLOCKED', desc: 'Deprecated site-local fec0::1' },
    { ip: 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'Site-local upper boundary feff:...' },

    // Multicast ff00::/8
    { ip: 'ff00::', expected: 'BLOCKED', desc: 'Multicast lowest boundary ff00::' },
    { ip: 'ff01::1', expected: 'BLOCKED', desc: 'Multicast node-local ff01::1' },
    { ip: 'ff02::1', expected: 'BLOCKED', desc: 'Multicast link-local ff02::1' },
    { ip: 'ff0e::1', expected: 'BLOCKED', desc: 'Multicast global ff0e::1 (all multicast blocked)' },
    { ip: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'Multicast highest boundary ffff:...' },

    // Discard prefix 100::/64 (RFC 6666)
    { ip: '100::', expected: 'BLOCKED', desc: 'Discard lowest boundary 100::' },
    { ip: '100::1', expected: 'BLOCKED', desc: 'Discard 100::1' },
    { ip: '0100:0:0:0:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'Discard upper boundary 100::/64' },
    { ip: '100:0:0:1::1', expected: 'ALLOWED', desc: 'Outside discard /64 (w3 != 0)' },

    // Documentation 2001:db8::/32 (RFC 3849)
    { ip: '2001:db8::', expected: 'BLOCKED', desc: 'Documentation 2001:db8::' },
    { ip: '2001:db8::1', expected: 'BLOCKED', desc: 'Documentation 2001:db8::1' },
    { ip: '2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'Documentation upper boundary' },
    { ip: '2001:db9::1', expected: 'ALLOWED', desc: 'Outside documentation prefix 2001:db9::1' },

    // Benchmarking 2001:2::/48 (RFC 5180)
    { ip: '2001:2::', expected: 'BLOCKED', desc: 'Benchmarking 2001:2::' },
    { ip: '2001:2::1', expected: 'BLOCKED', desc: 'Benchmarking 2001:2::1' },
    { ip: '2001:0002:0000:ffff:ffff:ffff:ffff:ffff', expected: 'BLOCKED', desc: 'Benchmarking upper boundary' },
    { ip: '2001:2:1::1', expected: 'ALLOWED', desc: 'Outside benchmarking prefix 2001:2:1::1' },

    // Teredo 2001:0000::/32 (RFC 4380)
    { ip: '2001:0000::1', expected: 'BLOCKED', desc: 'Teredo 2001:0000::1' },
    { ip: '2001::1', expected: 'BLOCKED', desc: 'Teredo 2001::1 (w1=0)' },
    { ip: '2001:0:1234::5678', expected: 'BLOCKED', desc: 'Teredo 2001:0::' },
  ];

  for (const tc of specialRfcCases) {
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('Special RFC Ranges', tc.desc, tc.ip, tc.expected as any, isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 6. Zero Compression, Expansion & Normalization Variations
  // ----------------------------------------------------------------------
  console.log('--- 6. Zero Compression & Expansion Variations ---');
  const zeroCases = [
    // Loopbacks
    { ip: '::1', expected: 'BLOCKED', desc: 'Standard loopback ::1' },
    { ip: '0::1', expected: 'BLOCKED', desc: '0::1' },
    { ip: '00::1', expected: 'BLOCKED', desc: '00::1' },
    { ip: '000::1', expected: 'BLOCKED', desc: '000::1' },
    { ip: '0000::1', expected: 'BLOCKED', desc: '0000::1' },
    { ip: '::0001', expected: 'BLOCKED', desc: '::0001' },
    { ip: '0::0001', expected: 'BLOCKED', desc: '0::0001' },
    { ip: '0000::0001', expected: 'BLOCKED', desc: '0000::0001' },
    { ip: '0:0:0:0:0:0:0:1', expected: 'BLOCKED', desc: '0:0:0:0:0:0:0:1' },
    { ip: '0000:0000:0000:0000:0000:0000:0000:0001', expected: 'BLOCKED', desc: '32-hex loopback' },

    // Unspecified
    { ip: '::', expected: 'BLOCKED', desc: 'Standard unspecified ::' },
    { ip: '::0', expected: 'BLOCKED', desc: '::0' },
    { ip: '0::', expected: 'BLOCKED', desc: '0::' },
    { ip: '0::0', expected: 'BLOCKED', desc: '0::0' },
    { ip: '0000::0000', expected: 'BLOCKED', desc: '0000::0000' },
    { ip: '0:0:0:0:0:0:0:0', expected: 'BLOCKED', desc: '0:0:0:0:0:0:0:0' },
    { ip: '0000:0000:0000:0000:0000:0000:0000:0000', expected: 'BLOCKED', desc: '32-hex unspecified' },

    // Public IPv6 variations
    { ip: '2607:f8b0:4005:805::200e', expected: 'ALLOWED', desc: 'Public Google IPv6' },
    { ip: '2607:F8B0:4005:0805:0000:0000:0000:200E', expected: 'ALLOWED', desc: 'Public Google IPv6 expanded mixed case' },
    { ip: '2606:4700:4700::1111', expected: 'ALLOWED', desc: 'Public Cloudflare IPv6' },
    { ip: '2606:4700:4700:0000:0000:0000:0000:1111', expected: 'ALLOWED', desc: 'Public Cloudflare IPv6 expanded' },
  ];

  for (const tc of zeroCases) {
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('Zero Variations', tc.desc, tc.ip, tc.expected as any, isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 7. Malformed IPv6 Inputs (Must Fail Closed / Return BLOCKED)
  // ----------------------------------------------------------------------
  console.log('--- 7. Malformed IPv6 & Syntax Abuse (Fail-Closed) ---');
  const malformedCases = [
    { ip: '1::2::3', desc: 'Multiple double colons (1::2::3)' },
    { ip: '::1::', desc: 'Multiple double colons (::1::)' },
    { ip: ':::1', desc: 'Triple leading colon' },
    { ip: '1:::2', desc: 'Triple colon in middle' },
    { ip: '::::', desc: 'Quad colon' },
    { ip: ':1:2:3:4:5:6:7:8', desc: 'Leading single colon without compression' },
    { ip: '1:2:3:4:5:6:7:8:', desc: 'Trailing single colon without compression' },
    { ip: '1:2:3:4:5:6:7', desc: 'Too few hextets (7 words)' },
    { ip: '1:2:3:4:5:6:7:8:9', desc: 'Too many hextets (9 words)' },
    { ip: '::1:2:3:4:5:6:7:8', desc: ':: with 8 words (9 total words)' },
    { ip: '10000::1', desc: 'Hextet value overflow (> 0xffff)' },
    { ip: '::10000', desc: 'Trailing hextet overflow' },
    { ip: '::g', desc: 'Non-hex character g' },
    { ip: 'fe80::xyz', desc: 'Non-hex word xyz' },
    { ip: '[::1', desc: 'Unclosed bracket' },
    { ip: '::1]', desc: 'Unopened bracket' },
    { ip: '', desc: 'Empty string' },
    { ip: '   ', desc: 'Whitespace only' },
  ];

  for (const tc of malformedCases) {
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('Malformed IPv6', tc.desc, tc.ip, 'BLOCKED', isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 8. Obfuscated IPv4 Variations & Non-Standard Formats
  // ----------------------------------------------------------------------
  console.log('--- 8. Obfuscated IPv4 Representations ---');
  const obfuscatedV4Cases = [
    { ip: '0177.0.0.1', desc: 'Octal dotted loopback' },
    { ip: '017700000001', desc: 'Single octal integer' },
    { ip: '2130706433', desc: 'Dword integer loopback' },
    { ip: '0x7f.0.0.1', desc: 'Hex dotted loopback' },
    { ip: '0x7f000001', desc: 'Hex integer loopback' },
    { ip: '012.0.0.1', desc: 'Octal 10.0.0.1' },
    { ip: '2852039166', desc: 'Dword IMDS 169.254.169.254' },
    { ip: '0xa9fea9fe', desc: 'Hex IMDS' },
    { ip: '127.0.0.1:80', desc: 'IPv4 with port injection' },
    { ip: '127.0.0.1/32', desc: 'IPv4 with CIDR notation' },
    { ip: '127.1', desc: 'Shortened 2-part IPv4' },
    { ip: '127.0.1', desc: 'Shortened 3-part IPv4' },
    { ip: ' 127.0.0.1 ', desc: 'Leading and trailing spaces' },
  ];

  for (const tc of obfuscatedV4Cases) {
    const isBlocked = isPrivateOrBlockedIP(tc.ip);
    check('Obfuscated IPv4', tc.desc, tc.ip, 'BLOCKED', isBlocked ? 'BLOCKED' : 'ALLOWED');
  }

  // ----------------------------------------------------------------------
  // 9. Endpoint URL Boundary Tests (validatePushEndpoint)
  // ----------------------------------------------------------------------
  console.log('--- 9. Push Endpoint Boundary Edge Cases ---');

  // Exact 2048 chars vs 2049 chars
  const baseValidFCM = 'https://fcm.googleapis.com/fcm/send/test?param=';
  const padLen2048 = 2048 - baseValidFCM.length;
  const endpoint2048 = baseValidFCM + 'a'.repeat(padLen2048);
  const endpoint2049 = baseValidFCM + 'a'.repeat(padLen2048 + 1);

  // We mock dns.promises.lookup for valid FCM to test length without network dependency
  const origLookup = dns.promises.lookup;
  dns.promises.lookup = (async (hostname: string) => {
    if (hostname === 'fcm.googleapis.com') {
      return [{ address: '142.250.190.46', family: 4 }] as dns.LookupAddress[];
    }
    return origLookup(hostname);
  }) as any;

  try {
    const res2048 = await validatePushEndpoint(endpoint2048);
    check('URL Boundary', 'Exactly 2048 chars', endpoint2048.slice(0, 50) + '...', 'ALLOWED', res2048.valid ? 'ALLOWED' : 'BLOCKED');

    const res2049 = await validatePushEndpoint(endpoint2049);
    check('URL Boundary', 'Exceeds 2048 chars (2049)', endpoint2049.slice(0, 50) + '...', 'BLOCKED', res2049.valid ? 'ALLOWED' : 'BLOCKED');

    // Userinfo tricks
    const userinfoCases = [
      { url: 'https://fcm.googleapis.com@evil.com/test', desc: 'Userinfo redirect spoof' },
      { url: 'https://user:pass@fcm.googleapis.com/test', desc: 'Credentials in URL' },
      { url: 'https://user%3Apass@fcm.googleapis.com/test', desc: 'URL-encoded credentials' },
    ];
    for (const tc of userinfoCases) {
      const res = await validatePushEndpoint(tc.url);
      check('URL Boundary', tc.desc, tc.url, 'BLOCKED', res.valid ? 'ALLOWED' : 'BLOCKED');
    }

    // Origin spoofing / homoglyphs
    const spoofCases = [
      { url: 'https://fcm.gооgleapis.com/test', desc: 'Cyrillic homoglyph in googleapis' },
      { url: 'https://xn--fcm-9cd.googleapis.com/test', desc: 'Punycode subdomain spoof' },
      { url: 'https://fcm.googleapis.com.evil.com/test', desc: 'Appended evil domain' },
      { url: 'https://evil.com/fcm.googleapis.com', desc: 'Allowed origin in path' },
      { url: 'https://push.apple.com.attacker.io/test', desc: 'Appended attacker domain to Apple' },
      { url: 'https://notfcm.googleapis.com/test', desc: 'Subdomain prefix without dot' },
      { url: 'https://fcm.googleapis.com:8443/test', desc: 'Disallowed custom port 8443' },
      { url: 'https://fcm.googleapis.com:80/test', desc: 'Disallowed HTTP port 80' },
      { url: 'https://fcm.googleapis.com:0/test', desc: 'Port 0' },
    ];
    for (const tc of spoofCases) {
      const res = await validatePushEndpoint(tc.url);
      check('URL Spoofing', tc.desc, tc.url, 'BLOCKED', res.valid ? 'ALLOWED' : 'BLOCKED');
    }

    // DNS Rebinding with Mixed Records
    console.log('--- 10. DNS Rebinding with Dual-Stack & Mixed Records ---');

    // Case 1: Hostname resolves to [Public IPv4, Private IPv6 loopback]
    dns.promises.lookup = (async () => {
      return [
        { address: '142.250.190.46', family: 4 },
        { address: '::1', family: 6 },
      ] as dns.LookupAddress[];
    }) as any;
    const resMixedV6 = await validatePushEndpoint('https://fcm.googleapis.com/test');
    check('DNS Rebinding', 'Public IPv4 + Loopback IPv6 ::1', 'fcm.googleapis.com', 'BLOCKED', resMixedV6.valid ? 'ALLOWED' : 'BLOCKED');

    // Case 2: Hostname resolves to [Public IPv6, Private IPv4 IMDS]
    dns.promises.lookup = (async () => {
      return [
        { address: '2607:f8b0:4005:805::200e', family: 6 },
        { address: '169.254.169.254', family: 4 },
      ] as dns.LookupAddress[];
    }) as any;
    const resMixedIMDS = await validatePushEndpoint('https://fcm.googleapis.com/test');
    check('DNS Rebinding', 'Public IPv6 + IMDS 169.254.169.254', 'fcm.googleapis.com', 'BLOCKED', resMixedIMDS.valid ? 'ALLOWED' : 'BLOCKED');

    // Case 3: Hostname resolves to [Public IPv4, Hex IPv4-mapped loopback]
    dns.promises.lookup = (async () => {
      return [
        { address: '142.250.190.46', family: 4 },
        { address: '::ffff:7f00:0001', family: 6 },
      ] as dns.LookupAddress[];
    }) as any;
    const resMixedMapped = await validatePushEndpoint('https://fcm.googleapis.com/test');
    check('DNS Rebinding', 'Public IPv4 + Hex mapped loopback', 'fcm.googleapis.com', 'BLOCKED', resMixedMapped.valid ? 'ALLOWED' : 'BLOCKED');

    // Case 4: Hostname resolves to [Public IPv4, 6to4 private loopback]
    dns.promises.lookup = (async () => {
      return [
        { address: '142.250.190.46', family: 4 },
        { address: '2002:7f00:0001::', family: 6 },
      ] as dns.LookupAddress[];
    }) as any;
    const resMixed6to4 = await validatePushEndpoint('https://fcm.googleapis.com/test');
    check('DNS Rebinding', 'Public IPv4 + 6to4 loopback', 'fcm.googleapis.com', 'BLOCKED', resMixed6to4.valid ? 'ALLOWED' : 'BLOCKED');

    // Case 5: Hostname resolves to [Public IPv4, NAT64 prefix]
    dns.promises.lookup = (async () => {
      return [
        { address: '142.250.190.46', family: 4 },
        { address: '64:ff9b::1', family: 6 },
      ] as dns.LookupAddress[];
    }) as any;
    const resMixedNAT64 = await validatePushEndpoint('https://fcm.googleapis.com/test');
    check('DNS Rebinding', 'Public IPv4 + NAT64 prefix', 'fcm.googleapis.com', 'BLOCKED', resMixedNAT64.valid ? 'ALLOWED' : 'BLOCKED');

    // Case 6: Pure legitimate dual-stack public records
    dns.promises.lookup = (async () => {
      return [
        { address: '142.250.190.46', family: 4 },
        { address: '2607:f8b0:4005:805::200e', family: 6 },
      ] as dns.LookupAddress[];
    }) as any;
    const resPurePublic = await validatePushEndpoint('https://fcm.googleapis.com/test');
    check('DNS Rebinding', 'Legitimate dual-stack public [142.250.190.46, 2607:f8b0:4005:805::200e]', 'fcm.googleapis.com', 'ALLOWED', resPurePublic.valid ? 'ALLOWED' : 'BLOCKED');

  } finally {
    dns.promises.lookup = origLookup;
  }

  // ----------------------------------------------------------------------
  // 11. Agent Socket Pinning & TLS SNI Retention
  // ----------------------------------------------------------------------
  console.log('--- 11. Agent Pinning & TLS SNI Security ---');
  const pinnedV4Agent = createSafePushAgent('142.250.190.46', 'fcm.googleapis.com');
  const agentOptions = (pinnedV4Agent as any).options;
  check('Agent Security', 'TLS SNI Retention', agentOptions.servername, 'ALLOWED', agentOptions.servername === 'fcm.googleapis.com' ? 'ALLOWED' : 'BLOCKED');
  check('Agent Security', 'Agent Timeout Configured', String(agentOptions.timeout), 'ALLOWED', agentOptions.timeout === 10000 ? 'ALLOWED' : 'BLOCKED');

  // Verify lookup callback enforces pinned IP and ignores requested hostname
  let pinnedLookupTarget: string | null = null;
  let pinnedLookupFamily: number | null = null;
  agentOptions.lookup('any-malicious-hostname.attacker.com', {}, (_err: any, address: string, family: number) => {
    pinnedLookupTarget = address;
    pinnedLookupFamily = family;
  });
  check('Agent Security', 'Lookup Callback Pinned IP', pinnedLookupTarget!, 'ALLOWED', pinnedLookupTarget === '142.250.190.46' ? 'ALLOWED' : 'BLOCKED');
  check('Agent Security', 'Lookup Callback Pinned Family', String(pinnedLookupFamily), 'ALLOWED', pinnedLookupFamily === 4 ? 'ALLOWED' : 'BLOCKED');

  // Test IPv6 pinned agent
  const pinnedV6Agent = createSafePushAgent('[2607:f8b0:4005:805::200e]', 'fcm.googleapis.com');
  const agentV6Options = (pinnedV6Agent as any).options;
  let pinnedV6LookupTarget: string | null = null;
  let pinnedV6LookupFamily: number | null = null;
  agentV6Options.lookup('rebound.attacker.com', {}, (_err: any, address: string, family: number) => {
    pinnedV6LookupTarget = address;
    pinnedV6LookupFamily = family;
  });
  check('Agent Security', 'IPv6 Stripped Brackets in Agent', pinnedV6LookupTarget!, 'ALLOWED', pinnedV6LookupTarget === '2607:f8b0:4005:805::200e' ? 'ALLOWED' : 'BLOCKED');
  check('Agent Security', 'IPv6 Family Flag in Agent', String(pinnedV6LookupFamily), 'ALLOWED', pinnedV6LookupFamily === 6 ? 'ALLOWED' : 'BLOCKED');

  // ----------------------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------------------
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n======================================================================');
  console.log(`TOTAL DEEP DIVE TESTS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('======================================================================\n');

  if (failed > 0) {
    console.error(`CRITICAL: ${failed} boundary attack vectors failed SSRF defenses!`);
    process.exit(1);
  } else {
    console.log('ALL EMPIRICAL BOUNDARY DEEP DIVE CHECKS PASSED WITH ZERO FAILURES.');
    process.exit(0);
  }
}

runBoundaryDeepDive().catch((err) => {
  console.error('Unhandled deep dive error:', err);
  process.exit(1);
});
