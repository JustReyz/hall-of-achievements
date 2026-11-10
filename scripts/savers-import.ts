import { readFile } from 'node:fs/promises';
import { getDb } from '../src/lib/db';
import { importSavers } from '../src/lib/finance/savers-import';

async function main() {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf('--source');
  const mappingIndex = args.indexOf('--mapping');
  const sourcePath = sourceIndex < 0 ? undefined : args[sourceIndex + 1];
  const mappingPath = mappingIndex < 0 ? undefined : args[mappingIndex + 1];
  if (!sourcePath || sourcePath.startsWith('--') || !mappingPath || mappingPath.startsWith('--')) {
    throw new Error('Usage: npm run finance:import -- --source <export.json> --mapping <mapping.json> [--apply]');
  }
  const source: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
  const mappings: unknown = JSON.parse(await readFile(mappingPath, 'utf8'));
  const apply = args.includes('--apply');
  const result = await importSavers(await getDb(), source, mappings, { apply });
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview-rolled-back', result }, null, 2));
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Import failed.');
  process.exit(1);
});
