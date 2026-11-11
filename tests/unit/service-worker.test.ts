import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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

  it('focuses the matching finance page and rejects external notification destinations', async () => {
    const handlers: Record<string, (event: { notification: { data: { url: string }; close: () => void }; waitUntil: (task: Promise<unknown>) => void }) => void> = {};
    const financeFocus = vi.fn().mockResolvedValue(undefined);
    const fakeFocus = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn().mockResolvedValue(undefined);
    let clients = [{ url: 'https://app.example/finance', focus: financeFocus }];
    const self = { addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; }, location: { origin: 'https://app.example' }, clients: { matchAll: async () => clients, openWindow } };
    vm.runInNewContext(swContent, { self, URL });
    let pending: Promise<unknown> = Promise.resolve();
    const click = (url: string) => handlers.notificationclick!({ notification: { data: { url }, close: vi.fn() }, waitUntil: (task) => { pending = task; } });
    click('/finance'); await pending;
    expect(financeFocus).toHaveBeenCalledOnce();
    clients = [{ url: 'https://evil.example/?https://app.example/', focus: fakeFocus }];
    click('https://evil.example/'); await pending;
    expect(fakeFocus).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith('/');
  });
});
