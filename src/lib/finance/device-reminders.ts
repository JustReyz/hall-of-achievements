export function deviceNotificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function enableDeviceNotifications(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') throw new Error('Browser ini tidak mendukung notifikasi.');
  return Notification.requestPermission();
}

export async function sendDeviceReminder(reminderId: string): Promise<void> {
  if (deviceNotificationPermission() !== 'granted') throw new Error('Aktifkan notifikasi perangkat terlebih dahulu.');
  const options: NotificationOptions = {
    body: 'Buka Keuangan untuk melihat pengingat Anda.',
    icon: '/favicon.ico',
    tag: `finance-reminder-${reminderId}`,
    data: { url: '/finance' },
  };
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification('Pengingat keuangan', options);
    return;
  }
  const notification = new Notification('Pengingat keuangan', options);
  notification.onclick = () => { window.focus(); notification.close(); };
}

export async function prepareFinancePushSubscription(publicKey: string) {
  if (deviceNotificationPermission() !== 'granted') throw new Error('Aktifkan notifikasi perangkat terlebih dahulu.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Browser ini tidak mendukung push notification.');
  const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4);
  const decoded = atob(padded);
  const key = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  if (key.length !== 65 || key[0] !== 4) throw new Error('Kunci notifikasi tidak valid.');
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const current = subscription.options.applicationServerKey;
    const bytes = current ? new Uint8Array(current) : null;
    if (!bytes || bytes.length !== key.length || bytes.some((value, index) => value !== key[index])) throw new Error('Langganan browser menggunakan kunci notifikasi lain.');
  } else {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as unknown as BufferSource });
  }
  const serialized = subscription.toJSON();
  if (!serialized.keys?.p256dh || !serialized.keys.auth) throw new Error('Kunci perangkat tidak tersedia.');
  return { endpoint: subscription.endpoint, keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth }, userAgent: navigator.userAgent };
}
