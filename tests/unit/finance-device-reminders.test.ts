import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceNotificationPermission, enableDeviceNotifications, prepareFinancePushSubscription, sendDeviceReminder } from '@/lib/finance/device-reminders';

describe('manual finance reminders', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests permission without sending a notification', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    const register = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    expect(await enableDeviceNotifications()).toBe('granted');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
  });

  it('sends only when requested and keeps notification content generic', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ showNotification });
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve({ showNotification }) } });
    await sendDeviceReminder('reminder-id');
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(showNotification).toHaveBeenCalledWith('Pengingat keuangan', expect.objectContaining({
      body: 'Buka Keuangan untuk melihat pengingat Anda.', tag: 'finance-reminder-reminder-id', data: { url: '/finance' },
    }));
  });

  it('does not send without permission', async () => {
    const register = vi.fn();
    vi.stubGlobal('Notification', { permission: 'denied' });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    expect(deviceNotificationPermission()).toBe('denied');
    await expect(sendDeviceReminder('reminder-id')).rejects.toThrow('Aktifkan notifikasi');
    expect(register).not.toHaveBeenCalled();
  });

  it('registers a push subscription without sending a notification', async () => {
    const key = Uint8Array.from([4, ...new Array<number>(64).fill(2)]);
    const publicKey = Buffer.from(key).toString('base64url');
    const subscription = { endpoint: 'https://example.test/push', toJSON: () => ({ keys: { p256dh: 'public', auth: 'auth' } }) };
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const register = vi.fn().mockResolvedValue(undefined);
    const showNotification = vi.fn();
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe }, showNotification };
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('window', { PushManager: function PushManager() {} });
    vi.stubGlobal('navigator', { userAgent: 'Test browser', serviceWorker: { register, ready: Promise.resolve(registration) } });
    expect(await prepareFinancePushSubscription(publicKey)).toEqual({ endpoint: subscription.endpoint, keys: { p256dh: 'public', auth: 'auth' }, userAgent: 'Test browser' });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(showNotification).not.toHaveBeenCalled();
  });
});
