#!/usr/bin/env tsx

/**
 * Operator Restore CLI Script
 * Usage: npx tsx scripts/restore.ts --input <dir>
 *
 * Restores schema-versioned metadata and binary assets from an offline archive.
 * Validates manifest SHA-256 integrity prior to any database or storage mutations.
 * Enforces post-restore security guarantees: all sessions revoked, all push subscriptions disabled.
 */

import { restoreArchive, IntegrityError } from '../src/lib/operations/restore';

function parseArgs(args: string[]): {
  inputDir?: string | undefined;
  help: boolean;
} {
  const result: {
    inputDir?: string | undefined;
    help: boolean;
  } = {
    inputDir: undefined,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--input' || arg === '-i') {
      const next = args[++i];
      if (next) result.inputDir = next;
    } else if (arg.startsWith('--input=')) {
      result.inputDir = arg.slice('--input='.length);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Hall of Achievements - Operator Restore CLI Tool
Usage:
  npx tsx scripts/restore.ts --input <dir>

Options:
  --input, -i <dir>    Input archive directory containing manifest.json (required)
  --help, -h           Show this help message
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.inputDir) {
    console.error('[RESTORE ERROR] Missing required argument: --input <dir>');
    printHelp();
    process.exit(1);
  }

  console.log(`[RESTORE] Initializing Operator Archive Restoration from: ${args.inputDir}`);

  try {
    const result = await restoreArchive({
      inputDir: args.inputDir,
    });

    console.log(`
[RESTORE SUCCESS] Archive restored successfully!
--------------------------------------------------
Directory:              ${result.inputDir}
Manifest Version:       ${result.manifest.version}
Exported At:            ${result.manifest.exportedAt}
Achievements Restored:  ${result.achievementsRestored}
Assets Restored:        ${result.assetsRestored}
Files Ingested:         ${result.filesRestored}
Total Bytes Restored:   ${(result.totalSizeBytes / 1024).toFixed(2)} KiB
Sessions Invalidation:  Enforced (all sessions revoked)
Push Subscriptions:     Enforced (all subscriptions disabled)
--------------------------------------------------
    `);
    process.exit(0);
  } catch (error: unknown) {
    if (error instanceof IntegrityError) {
      console.error(`\n[RESTORE FATAL - INTEGRITY VIOLATION] ${error.message}`);
      console.error('Pre-flight integrity verification failed. Zero database or storage changes were applied.');
    } else {
      console.error(`\n[RESTORE ERROR] ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

void main();
