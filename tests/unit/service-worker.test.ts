import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Unit: Service Worker Architecture & Privacy Boundaries (AC6, AC9)', () => {
  const swPath = path.resolve(process.cwd(), 'public', 'sw.js');
  const swContent = fs.readFileSync(swPath, 'utf-8');

  it('public/sw.js exists and is located at root public path', () => {
    expect(fs.existsSync(swPath)).toBe(true);
    expect(swContent.length).toBeGreaterThan(0);
  });

  it('strictly omits any fetch event listener (NO fetch handler)', () => {
    // PRD §5 & AC9: Service worker has NO fetch handler
    expect(swContent).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
    expect(swContent).not.toMatch(/self\.onfetch/);
  });

  it('strictly omits Cache API usage (NO Cache API, NO offline gallery storage)', () => {
    // PRD §5 & AC9: NO Cache API in MVP; handles push/notificationclick only
    expect(swContent).not.toMatch(/caches\.open/);
    expect(swContent).not.toMatch(/caches\.match/);
    expect(swContent).not.toMatch(/caches\.put/);
    expect(swContent).not.toMatch(/caches\.delete/);
    expect(swContent).not.toMatch(/caches\.keys/);
    expect(swContent).not.toMatch(/window\.caches/);
  });

  it('registers handlers for push and notificationclick events only', () => {
    expect(swContent).toMatch(/addEventListener\(\s*['"]push['"]/);
    expect(swContent).toMatch(/addEventListener\(\s*['"]notificationclick['"]/);
  });

  it('notificationclick targets same-origin root (/) which enforces login check', () => {
    // AC9: Notification click cannot bypass login; navigates to /
    expect(swContent).toMatch(/clients\.openWindow/);
    expect(swContent).toMatch(/'\/'/);
  });

  it('does not contain any embedded secrets, tokens, or private data', () => {
    expect(swContent).not.toContain('OWNER_ACCESS_CODE');
    expect(swContent).not.toContain('SESSION_VERSION_KEY');
    expect(swContent).not.toContain('VAPID_PRIVATE_KEY');
    expect(swContent).not.toContain('bearer');
    expect(swContent).not.toContain('Authorization');
  });
});
