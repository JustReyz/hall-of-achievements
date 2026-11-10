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
