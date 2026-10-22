#!/usr/bin/env tsx

/**
 * Operator Export CLI Script
 * Usage: npx tsx scripts/export.ts [--output <dir>] [--force] [--pretty]
 *
 * Dumps schema-versioned metadata and binary assets (original, display, thumbnail)
 * alongside an atomic SHA-256 integrity manifest.
 * Strictly excludes sessions, auth_state, rate_limits, push_subscriptions, and secrets.
 */

import { exportArchive } from '../src/lib/operations/export';

function parseArgs(args: string[]): {
  outputDir?: string | undefined;
  force: boolean;
  pretty: boolean;
  help: boolean;
} {
  const result: {
    outputDir?: string | undefined;
    force: boolean;
    pretty: boolean;
    help: boolean;
  } = {
    outputDir: undefined,
    force: false,
    pretty: true,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--output' || arg === '-o') {
      const next = args[++i];
      if (next) result.outputDir = next;
    } else if (arg.startsWith('--output=')) {
      result.outputDir = arg.slice('--output='.length);
    } else if (arg === '--force' || arg === '-f') {
      result.force = true;
    } else if (arg === '--pretty') {
      result.pretty = true;
    } else if (arg === '--no-pretty') {
      result.pretty = false;
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Hall of Achievements - Operator Export CLI Tool
Usage:
  npx tsx scripts/export.ts [options]

Options:
  --output, -o <dir>    Target archive directory (default: ./export-<ISO-timestamp>)
  --force, -f           Overwrite output directory if it exists and is not empty
  --no-pretty           Emit minified JSON metadata
  --help, -h            Show this help message
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('[EXPORT] Initializing Operator Archive Export...');

  try {
    const result = await exportArchive({
      outputDir: args.outputDir,
      force: args.force,
      pretty: args.pretty,
    });

    console.log(`
[EXPORT SUCCESS] Archive created successfully!
--------------------------------------------------
Directory:           ${result.outputDir}
Manifest Version:    ${result.manifest.version}
Timestamp:           ${result.manifest.exportedAt}
Achievements Count:  ${result.achievementsCount}
Assets Count:        ${result.assetsCount}
Total Files:         ${result.filesCount}
Archive Size:        ${(result.totalSizeBytes / 1024).toFixed(2)} KiB
--------------------------------------------------
    `);
    process.exit(0);
  } catch (error: unknown) {
    console.error(`\n[EXPORT ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
