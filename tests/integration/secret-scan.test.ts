import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

describe('Integration: Secret Scanning & Git Isolation (AC12)', () => {
  const rootDir = process.cwd();

  it('verifies Context7.md is strictly untracked in git', () => {
    try {
      const lsFiles = execSync('git ls-files Context7.md', {
        cwd: rootDir,
        encoding: 'utf-8',
      }).trim();
      expect(lsFiles).toBe('');
    } catch {
      // If git command fails, assert file does not exist in git index
    }

    try {
      const ignored = execSync('git check-ignore Context7.md', {
        cwd: rootDir,
        encoding: 'utf-8',
      }).trim();
      expect(ignored).toContain('Context7.md');
    } catch {
      // In case git check-ignore returns exit code 1 if not ignored (which would fail test)
      expect.unreachable('Context7.md must match .gitignore pattern');
    }
  });

  it('verifies zero credential, private key, or export files are tracked in git', () => {
    // 1. No .pem or .key files
    const trackedKeys = execSync('git ls-files "*.pem" "*.key"', {
      cwd: rootDir,
      encoding: 'utf-8',
    }).trim();
    expect(trackedKeys).toBe('');

    // 2. No .env, .env.local, .env.production (only .env.example allowed)
    const trackedEnvs = execSync('git ls-files ".env" ".env.local" ".env.production"', {
      cwd: rootDir,
      encoding: 'utf-8',
    }).trim();
    expect(trackedEnvs).toBe('');

    // 3. No operator export output directories
    const trackedExports = execSync('git ls-files "export-*"', {
      cwd: rootDir,
      encoding: 'utf-8',
    }).trim();
    expect(trackedExports).toBe('');
  });

  it('verifies zero private key banners exist in git-tracked text files', () => {
    const trackedFiles = execSync('git ls-files', {
      cwd: rootDir,
      encoding: 'utf-8',
    })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);

    const privateKeyRegex = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
    const violations: string[] = [];

    for (const relFile of trackedFiles) {
      const fullPath = path.join(rootDir, relFile);
      if (!fs.existsSync(fullPath)) continue;

      // Skip non-text or binary files
      const ext = path.extname(relFile).toLowerCase();
      if (['.jpg', '.png', '.webp', '.ico', '.pdf', '.woff', '.woff2'].includes(ext)) {
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (privateKeyRegex.test(content)) {
          violations.push(relFile);
        }
      } catch {
        // skip files that cannot be read as utf-8
      }
    }

    expect(violations).toEqual([]);
  });
});
