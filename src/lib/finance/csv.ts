export function financeCsv(rows: Array<Record<string, string | null>>) {
  const columns = ['date', 'wallet', 'type', 'category', 'source', 'amount', 'notes'] as const;
  const cells = rows.map((row) => columns.map((column) => csvCell(row[column] ?? '')));
  return [columns.join(','), ...cells.map((row) => row.join(','))].join('\r\n');
}

function csvCell(value: string): string {
  const safe = /^[\s]*[=+@\-]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
