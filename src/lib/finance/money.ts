/** Parse a positive decimal amount without converting money through floating point. */
export function parseMoney(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('Amount must be a decimal string with at most two fractional digits.');
  }
  const [whole = '0', fraction = ''] = value.split('.');
  const minorUnits = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minorUnits <= 0n) throw new Error('Amount must be greater than zero.');
  return minorUnits;
}

export function formatMoney(minorUnits: bigint): string {
  const sign = minorUnits < 0n ? '-' : '';
  const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
