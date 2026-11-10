import { readFile } from 'node:fs/promises';
import { preflightSaversExport } from '../src/lib/finance/savers-preflight';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npm run finance:preflight -- <export.json>');
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  const result = preflightSaversExport(data);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Could not inspect export.');
  process.exitCode = 1;
});
