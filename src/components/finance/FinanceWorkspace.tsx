'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { prepareProfileImage } from '@/lib/finance/profile-image';
import { deviceNotificationPermission, enableDeviceNotifications, sendDeviceReminder } from '@/lib/finance/device-reminders';
import styles from './FinanceWorkspace.module.css';

type Group = { id: string; name: string; role: 'owner' | 'admin' | 'member' };
type GroupMember = { id: string; username: string; role: 'owner' | 'admin' | 'member' };
type FinanceSource = { id: string; name: string; type: 'cash' | 'e-wallet' | 'bank' | 'other'; deletedAt?: string | null };
type FinanceSummary = { totalIncome: string; totalExpense: string; balance: string; budgetRemaining: string | null };
type GroupBudget = { monthlyLimit: string | null; currency: string; enabled: boolean };
type Wallet = {
  id: string;
  groupId: string;
  name: string;
  type: 'regular' | 'goal';
  targetAmount?: string | null;
  balance?: string | null;
};
type Transaction = {
  id: string;
  type: 'income' | 'expense';
  amount: string;
  category?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  notes?: string | null;
  createdAt?: string;
  transactionDate?: string;
};
type FinanceNote = { id: string; groupId: string; title: string; content: string | null; targetAt: string | null; isPinned: boolean; isCompleted: boolean };
type FinanceReminder = { id: string; noteId: string; remindAt: string; recurrence: string; status: string; message: string | null };
type FinanceScheduledTask = { id: string; title: string; details: string | null; scheduleAt: string; recurrence: string; isActive: boolean; completedAt: string | null };
type Session = { authenticated: boolean; user?: { id: string; username: string; profilePicture?: string | null } };
type TransactionList = { transactions: Transaction[]; hasMore: boolean };
type RecoveredTransaction = {
  id: string;
  walletId: string;
  type: 'income' | 'expense';
  amount: string;
  transactionDate: string;
  deletedAt?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pendingStorageKey(userId: string): string {
  return `hall.finance.pending-transaction.${userId}`;
}

function readPendingKey(userId: string): string | null {
  const key = window.localStorage.getItem(pendingStorageKey(userId));
  if (key && !UUID.test(key)) throw new Error('Penanda pemulihan transaksi tidak valid.');
  return key;
}

async function withTransactionLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request)
    throw new Error('Browser ini tidak mendukung penguncian transaksi antar tab.');
  return navigator.locks.request(
    `hall.finance.transaction-write.${userId}`,
    { mode: 'exclusive' },
    work
  );
}

async function assertFinanceUser(userId: string): Promise<void> {
  const current = await request<Session>('/api/finance/session');
  if (!current.authenticated || current.user?.id?.toLowerCase() !== userId) {
    throw new RequestError('Akun keuangan berubah. Muat ulang sesi dan periksa transaksi.', 401);
  }
}

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function localDateTimeNow(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('X-Requested-With', 'XMLHttpRequest');
  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (response.status === 204 && response.ok) return undefined as T;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RequestError(
      response.status === 404
        ? 'Fitur keuangan belum tersedia.'
        : 'Respons server tidak dapat dibaca.',
      response.status
    );
  }
  if (!response.ok) {
    const error =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? (payload as { error: unknown }).error
        : null;
    throw new RequestError(
      typeof error === 'string' ? error : 'Permintaan tidak berhasil.',
      response.status
    );
  }
  return payload as T;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Terjadi kesalahan. Coba lagi.';
}

// Keep the amount as text: converting a ledger amount to Number can lose precision.
function formatAmount(value: string): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value))
    return 'Jumlah tidak tersedia';
  const negative = value.startsWith('-');
  const [integer = '0', fraction] = (negative ? value.slice(1) : value).split('.');
  const formatted = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '−' : ''}Rp ${formatted}${fraction && /[1-9]/.test(fraction) ? `,${fraction.padEnd(2, '0')}` : ''}`;
}

export default function FinanceWorkspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [profileFile, setProfileFile] = useState<File | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [register, setRegister] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  const [sources, setSources] = useState<FinanceSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [budget, setBudget] = useState<GroupBudget>({ monthlyLimit: null, currency: 'IDR', enabled: false });
  const [budgetInput, setBudgetInput] = useState('');
  const [budgetEnabledInput, setBudgetEnabledInput] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletId, setWalletId] = useState('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [plannerNotes, setPlannerNotes] = useState<FinanceNote[]>([]);
  const [plannerReminders, setPlannerReminders] = useState<FinanceReminder[]>([]);
  const [plannerTasks, setPlannerTasks] = useState<FinanceScheduledTask[]>([]);
  const [plannerLoading, setPlannerLoading] = useState(false);
  const [devicePermission, setDevicePermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [noteTargetAt, setNoteTargetAt] = useState('');
  const [reminderNoteId, setReminderNoteId] = useState('');
  const [reminderAt, setReminderAt] = useState(localDateTimeNow);
  const [reminderRecurrence, setReminderRecurrence] = useState<'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'>('none');
  const [reminderMessage, setReminderMessage] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDetails, setTaskDetails] = useState('');
  const [taskScheduleAt, setTaskScheduleAt] = useState(localDateTimeNow);
  const [taskRecurrence, setTaskRecurrence] = useState<'once' | 'daily' | 'weekly' | 'monthly'>('once');
  const [hasMoreTransactions, setHasMoreTransactions] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [walletsLoading, setWalletsLoading] = useState(false);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupRename, setGroupRename] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceType, setSourceType] = useState<FinanceSource['type']>('bank');
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [walletName, setWalletName] = useState('');
  const [walletType, setWalletType] = useState<'regular' | 'goal'>('regular');
  const [targetAmount, setTargetAmount] = useState('');
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null);
  const [transactionType, setTransactionType] = useState<'income' | 'expense'>('income');
  const [amount, setAmount] = useState('');
  const [transactionDate, setTransactionDate] = useState(todayLocal);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [editingTransactionId, setEditingTransactionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const transactionFormRef = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const transactionAttempt = useRef<{ payload: string; key: string } | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageScope, setStorageScope] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<RecoveredTransaction | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const financeUserId =
    session?.authenticated && session.user?.id ? session.user.id.toLowerCase() : null;
  const canStoreTransactions =
    storageReady && financeUserId !== null && storageScope === financeUserId;

  useEffect(() => {
    setStorageReady(false);
    setStorageScope(null);
    setPendingKey(null);
    setRecoveryChecked(false);
    setRecovered(null);
    setStorageError(null);
    transactionAttempt.current = null;
    if (!financeUserId) return;
    const syncMarker = () => {
      try {
        if (!UUID.test(financeUserId)) throw new Error('Identitas akun keuangan tidak valid.');
        const marker = readPendingKey(financeUserId);
        if (!navigator.locks?.request)
          throw new Error('Browser ini tidak mendukung penguncian transaksi antar tab.');
        setPendingKey(marker);
        setRecoveryChecked(false);
        setRecovered(null);
        setStorageError(null);
        setStorageScope(financeUserId);
        setStorageReady(true);
      } catch (cause) {
        setStorageReady(false);
        setStorageError(message(cause));
      }
    };
    syncMarker();
    const onStorage = (event: StorageEvent) => {
      if (event.key === pendingStorageKey(financeUserId) || event.key === null) syncMarker();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [financeUserId]);

  const refreshSession = useCallback(async () => {
    setSessionLoading(true);
    setError(null);
    try {
      setSession(await request<Session>('/api/finance/session'));
    } catch (cause) {
      setSession(null);
      setError(message(cause));
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    const refreshPermission = () => setDevicePermission(deviceNotificationPermission());
    refreshPermission();
    window.addEventListener('focus', refreshPermission);
    return () => window.removeEventListener('focus', refreshPermission);
  }, []);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('invite');
    if (!token) return;
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setInviteToken(token);
      setRegister(true);
    }
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, []);

  const reportError = useCallback(
    (cause: unknown) => {
      if (cause instanceof RequestError && cause.status === 401) {
        setSession(null);
        setGroups([]);
        setWallets([]);
        setTransactions([]);
        void refreshSession();
        return;
      }
      setError(message(cause));
    },
    [refreshSession]
  );

  const refreshGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const result = await request<{ groups: Group[] }>('/api/finance/groups');
      setGroups(result.groups);
      setGroupId((current) =>
        result.groups.some((group) => group.id === current) ? current : (result.groups[0]?.id ?? '')
      );
    } catch (cause) {
      reportError(cause);
    } finally {
      setGroupsLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    setGroupRename(groups.find((group) => group.id === groupId)?.name ?? '');
  }, [groups, groupId]);

  useEffect(() => {
    if (session?.authenticated) void refreshGroups();
    else {
      setGroups([]);
      setGroupId('');
    }
  }, [session?.authenticated, refreshGroups]);

  useEffect(() => {
    setInviteUrl(null);
    setMembers([]);
    if (!groupId || !session?.authenticated) return;
    const controller = new AbortController();
    void request<{ members: GroupMember[] }>(`/api/finance/invitations?groupId=${encodeURIComponent(groupId)}`, { signal: controller.signal })
      .then((result) => setMembers(result.members))
      .catch((cause: unknown) => { if (!controller.signal.aborted) reportError(cause); });
    return () => controller.abort();
  }, [groupId, session?.authenticated, reportError]);

  useEffect(() => {
    setSummary(null);
    setSources([]);
    setSourceId('');
    setBudget({ monthlyLimit: null, currency: 'IDR', enabled: false });
    setBudgetInput('');
    setBudgetEnabledInput(false);
    if (!groupId || !session?.authenticated) return;
    const controller = new AbortController();
    const query = `groupId=${encodeURIComponent(groupId)}`;
    void Promise.all([
      request<{ sources: FinanceSource[] }>(`/api/finance/sources?${query}`, { signal: controller.signal }),
      request<{ budget: GroupBudget }>(`/api/finance/budgets?${query}`, { signal: controller.signal }),
      request<{ summary: FinanceSummary }>(`/api/finance/summary?${query}`, { signal: controller.signal }),
    ]).then(([sourceResult, budgetResult, summaryResult]) => {
      setSources(sourceResult.sources);
      setSourceId((current) => sourceResult.sources.some((source) => source.id === current) ? current : '');
      setBudget(budgetResult.budget);
      setBudgetInput(budgetResult.budget.monthlyLimit ?? '');
      setBudgetEnabledInput(budgetResult.budget.enabled);
      setSummary(summaryResult.summary);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) reportError(cause); });
    return () => controller.abort();
  }, [groupId, session?.authenticated, reportError]);

  useEffect(() => {
    setPlannerNotes([]);
    setPlannerReminders([]);
    setPlannerTasks([]);
    setReminderNoteId('');
    if (!groupId || !session?.authenticated) { setPlannerLoading(false); return; }
    const controller = new AbortController();
    setPlannerLoading(true);
    const query = `groupId=${encodeURIComponent(groupId)}`;
    void Promise.all([
      request<{ notes: FinanceNote[] }>(`/api/finance/planner/notes?${query}`, { signal: controller.signal }),
      request<{ reminders: FinanceReminder[] }>(`/api/finance/planner/reminders?${query}`, { signal: controller.signal }),
      request<{ tasks: FinanceScheduledTask[] }>(`/api/finance/planner/scheduled-tasks?${query}`, { signal: controller.signal }),
    ]).then(([notesResult, remindersResult, tasksResult]) => {
      setPlannerNotes(notesResult.notes);
      setPlannerReminders(remindersResult.reminders);
      setReminderNoteId((current) => notesResult.notes.some((note) => note.id === current) ? current : (notesResult.notes[0]?.id ?? ''));
      setPlannerTasks(tasksResult.tasks);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) reportError(cause); })
      .finally(() => { if (!controller.signal.aborted) setPlannerLoading(false); });
    return () => controller.abort();
  }, [groupId, session?.authenticated, reportError]);

  useEffect(() => {
    setWallets([]);
    setWalletId('');
    setTransactions([]);
    setHasMoreTransactions(false);
    if (!session?.authenticated || !groupId) return;
    const controller = new AbortController();
    setWalletsLoading(true);
    void request<{ wallets: Wallet[] }>(
      `/api/finance/wallets?groupId=${encodeURIComponent(groupId)}`,
      { signal: controller.signal }
    )
      .then((result) => {
        setWallets(result.wallets);
        setWalletId(result.wallets[0]?.id ?? '');
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) reportError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setWalletsLoading(false);
      });
    return () => controller.abort();
  }, [groupId, session?.authenticated, reportError]);

  const refreshWallets = useCallback(async () => {
    if (!groupId) return;
    const result = await request<{ wallets: Wallet[] }>(
      `/api/finance/wallets?groupId=${encodeURIComponent(groupId)}`
    );
    setWallets(result.wallets);
    setWalletId((current) =>
      result.wallets.some((wallet) => wallet.id === current)
        ? current
        : (result.wallets[0]?.id ?? '')
    );
  }, [groupId]);

  const refreshTransactions = useCallback(async () => {
    if (!walletId) return;
    const result = await request<TransactionList>(
      `/api/finance/transactions?walletId=${encodeURIComponent(walletId)}`
    );
    setTransactions(result.transactions);
    setHasMoreTransactions(result.hasMore);
  }, [walletId]);

  const refreshSummary = useCallback(async () => {
    if (!groupId) return;
    const result = await request<{ summary: FinanceSummary }>(`/api/finance/summary?groupId=${encodeURIComponent(groupId)}`);
    setSummary(result.summary);
  }, [groupId]);

  const refreshPlanner = useCallback(async () => {
    if (!groupId) return;
    const query = `groupId=${encodeURIComponent(groupId)}`;
    const [notesResult, remindersResult, tasksResult] = await Promise.all([
      request<{ notes: FinanceNote[] }>(`/api/finance/planner/notes?${query}`),
      request<{ reminders: FinanceReminder[] }>(`/api/finance/planner/reminders?${query}`),
      request<{ tasks: FinanceScheduledTask[] }>(`/api/finance/planner/scheduled-tasks?${query}`),
    ]);
    setPlannerNotes(notesResult.notes);
    setPlannerReminders(remindersResult.reminders);
    setReminderNoteId((current) => notesResult.notes.some((note) => note.id === current) ? current : (notesResult.notes[0]?.id ?? ''));
    setPlannerTasks(tasksResult.tasks);
  }, [groupId]);

  useEffect(() => {
    setTransactions([]);
    setHasMoreTransactions(false);
    if (!session?.authenticated || !walletId) return;
    const controller = new AbortController();
    setTransactionsLoading(true);
    void request<TransactionList>(
      `/api/finance/transactions?walletId=${encodeURIComponent(walletId)}`,
      { signal: controller.signal }
    )
      .then((result) => {
        setTransactions(result.transactions);
        setHasMoreTransactions(result.hasMore);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) reportError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setTransactionsLoading(false);
      });
    return () => controller.abort();
  }, [walletId, session?.authenticated, reportError]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await request<Session>('/api/finance/session', {
        method: 'POST',
        body: JSON.stringify({
          action: register ? 'register' : 'login',
          username: username.trim(),
          password,
          ...(inviteToken ? { inviteToken } : {}),
        }),
      });
      setSession(result);
      setPassword('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const createInvitation = async () => {
    if (!groupId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await request<{ invitation: { url: string } }>('/api/finance/invitations', {
        method: 'POST', body: JSON.stringify({ groupId }),
      });
      setInviteUrl(result.invitation.url);
      setNotice('Undangan berlaku selama 7 hari dan hanya dapat digunakan sekali.');
    } catch (cause) {
      setError(message(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const copyInvitation = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setNotice('Tautan undangan disalin.');
    } catch {
      setNotice('Salin tautan undangan dari kolom di bawah.');
    }
  };

  const createFinanceSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await request<{ source: FinanceSource }>('/api/finance/sources', {
        method: 'POST', body: JSON.stringify({ groupId, name: sourceName.trim(), type: sourceType }),
      });
      setSources((current) => [result.source, ...current]);
      setSourceId(result.source.id);
      setSourceName('');
      setNotice('Sumber transaksi dibuat.');
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const saveFinanceSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingSourceId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await request<{ source: FinanceSource }>(`/api/finance/sources/${editingSourceId}`, { method: 'PATCH', body: JSON.stringify({ name: sourceName.trim(), type: sourceType }) });
      setSources((current) => current.map((source) => source.id === result.source.id ? result.source : source));
      setEditingSourceId(null); setSourceName(''); setNotice('Sumber transaksi diperbarui.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removeFinanceSource = async (source: FinanceSource) => {
    if (busyRef.current || !window.confirm(`Nonaktifkan sumber “${source.name}”? Transaksi lama tetap mencatat nama sumber ini.`)) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request(`/api/finance/sources/${source.id}`, { method: 'DELETE' });
      setSources((current) => current.filter((item) => item.id !== source.id));
      if (sourceId === source.id) setSourceId('');
      setNotice('Sumber dinonaktifkan; riwayat transaksi tetap tersimpan.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const saveProfilePicture = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profileFile || busyRef.current) return;
    const form = event.currentTarget;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const image = await prepareProfileImage(profileFile);
      const result = await request<{ profilePicture: string }>(
        '/api/finance/profile-picture',
        { method: 'PUT', headers: { 'Content-Type': image.type || 'application/octet-stream' }, body: image },
      );
      setSession((current) => current?.user ? { ...current, user: { ...current.user, profilePicture: result.profilePicture } } : current);
      setProfileFile(null); form.reset(); setNotice('Foto profil disimpan.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removeProfilePicture = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request('/api/finance/profile-picture', { method: 'DELETE' });
      setSession((current) => current?.user ? { ...current, user: { ...current.user, profilePicture: null } } : current);
      setNotice('Foto profil dihapus.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const createPlannerNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request('/api/finance/planner/notes', { method: 'POST', body: JSON.stringify({ groupId, title: noteTitle.trim(), content: noteContent.trim() || null, targetAt: noteTargetAt ? new Date(noteTargetAt).toISOString() : null }) });
      setNoteTitle(''); setNoteContent(''); setNoteTargetAt('');
      await refreshPlanner(); setNotice('Catatan planner disimpan.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const updatePlannerNote = async (note: FinanceNote, changes: Record<string, unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request(`/api/finance/planner/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
      await refreshPlanner(); setNotice('Catatan diperbarui.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removePlannerNote = async (note: FinanceNote) => {
    if (busyRef.current || !window.confirm('Hapus catatan dan pengingat terkait?')) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request(`/api/finance/planner/notes/${note.id}`, { method: 'DELETE' });
      await refreshPlanner(); setNotice('Catatan dan pengingat terkait dihapus.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const createPlannerReminder = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupId || !reminderNoteId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request('/api/finance/planner/reminders', { method: 'POST', body: JSON.stringify({ groupId, noteId: reminderNoteId, reminderType: reminderRecurrence === 'none' ? 'relative' : 'recurring', recurrence: reminderRecurrence, remindAt: new Date(reminderAt).toISOString(), message: reminderMessage.trim() || null }) });
      setReminderMessage(''); await refreshPlanner(); setNotice('Pengingat tersimpan. Tidak ada notifikasi yang dikirim otomatis.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const enableReminderNotifications = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const permission = await enableDeviceNotifications();
      setDevicePermission(permission);
      setNotice(permission === 'granted' ? 'Notifikasi perangkat aktif. Pilih pengingat untuk mengirim.' : 'Izin notifikasi belum diberikan.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const sendReminderToDevice = async (id: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await sendDeviceReminder(id); setNotice('Notifikasi diminta untuk perangkat ini. Status pengingat tetap tersimpan.'); }
    catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const cancelPlannerReminder = async (id: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await request(`/api/finance/planner/reminders/${id}`, { method: 'DELETE' }); await refreshPlanner(); setNotice('Pengingat dibatalkan.'); }
    catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const createPlannerTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request('/api/finance/planner/scheduled-tasks', { method: 'POST', body: JSON.stringify({ groupId, title: taskTitle.trim(), details: taskDetails.trim() || null, scheduleAt: new Date(taskScheduleAt).toISOString(), recurrence: taskRecurrence }) });
      setTaskTitle(''); setTaskDetails(''); await refreshPlanner(); setNotice('Tugas terjadwal disimpan.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const updatePlannerTask = async (task: FinanceScheduledTask, changes: Record<string, unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await request(`/api/finance/planner/scheduled-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify(changes) }); await refreshPlanner(); setNotice('Tugas diperbarui.'); }
    catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removePlannerTask = async (task: FinanceScheduledTask) => {
    if (busyRef.current || !window.confirm('Hapus tugas terjadwal ini?')) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await request(`/api/finance/planner/scheduled-tasks/${task.id}`, { method: 'DELETE' }); await refreshPlanner(); setNotice('Tugas dihapus.'); }
    catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const saveGroupBudget = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await request<{ budget: GroupBudget }>('/api/finance/budgets', {
        method: 'PUT', body: JSON.stringify({ groupId, monthlyLimit: budgetInput.trim() || null, enabled: budgetEnabledInput, currency: 'IDR' }),
      });
      setBudget(result.budget);
      setNotice(result.budget.enabled ? 'Anggaran bulanan disimpan.' : 'Anggaran bulanan dinonaktifkan.');
      const { summary: refreshed } = await request<{ summary: FinanceSummary }>(`/api/finance/summary?groupId=${encodeURIComponent(groupId)}`);
      setSummary(refreshed);
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await request('/api/finance/session', { method: 'DELETE' });
      setSession({ authenticated: false });
      setNotice('Anda telah keluar dari akun keuangan.');
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const createGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await request('/api/finance/groups', {
        method: 'POST',
        body: JSON.stringify({ name: groupName.trim() }),
      });
      setGroupName('');
      await refreshGroups();
      setNotice('Grup berhasil dibuat.');
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const renameGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request(`/api/finance/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify({ name: groupRename.trim() }) });
      await refreshGroups(); setNotice('Nama grup diperbarui.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removeGroup = async () => {
    if (!groupId || busyRef.current || !window.confirm('Hapus grup kosong ini? Grup yang berisi dompet tidak dapat dihapus.')) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await request(`/api/finance/groups/${groupId}`, { method: 'DELETE' }); await refreshGroups(); setNotice('Grup kosong dihapus.'); }
    catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const changeMemberRole = async (member: GroupMember, role: 'admin' | 'member') => {
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request(`/api/finance/groups/${groupId}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      const result = await request<{ members: GroupMember[] }>(`/api/finance/invitations?groupId=${encodeURIComponent(groupId)}`);
      setMembers(result.members); setNotice('Peran anggota diperbarui.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removeMember = async (member: GroupMember) => {
    if (!groupId || busyRef.current || !window.confirm(`Keluarkan ${member.username} dari grup? Riwayat transaksinya tetap disimpan.`)) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request(`/api/finance/groups/${groupId}/members/${member.id}`, { method: 'DELETE' });
      const result = await request<{ members: GroupMember[] }>(`/api/finance/invitations?groupId=${encodeURIComponent(groupId)}`);
      setMembers(result.members); setNotice('Anggota dikeluarkan dari grup.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const revokeInvitations = async () => {
    if (!groupId || busyRef.current || !window.confirm('Cabut semua tautan undangan yang belum dipakai?')) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await request<{ revoked: number }>(`/api/finance/invitations?groupId=${encodeURIComponent(groupId)}`, { method: 'DELETE' });
      setInviteUrl(null); setNotice(`${result.revoked} undangan dicabut.`);
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const createWallet = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !groupId) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await request('/api/finance/wallets', {
        method: 'POST',
        body: JSON.stringify({
          groupId,
          name: walletName.trim(),
          type: walletType,
          targetAmount: walletType === 'goal' ? targetAmount.trim() : null,
        }),
      });
      setWalletName('');
      setTargetAmount('');
      setWalletType('regular');
      try {
        await refreshWallets();
        setNotice('Dompet berhasil dibuat.');
      } catch (cause) {
        reportError(cause);
        setNotice(
          'Dompet berhasil dibuat, tetapi daftar belum dapat diperbarui. Muat ulang halaman untuk melihatnya.'
        );
      }
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const saveWallet = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !editingWalletId) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await request(`/api/finance/wallets/${editingWalletId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: walletName.trim(), type: walletType, targetAmount: walletType === 'goal' ? targetAmount.trim() : null }),
      });
      setEditingWalletId(null);
      setWalletName('');
      setTargetAmount('');
      setWalletType('regular');
      await refreshWallets();
      setNotice('Pengaturan dompet berhasil disimpan.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removeWallet = async (id: string) => {
    if (busyRef.current || !window.confirm('Hapus dompet kosong ini? Dompet dengan riwayat transaksi tidak dapat dihapus.')) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await request(`/api/finance/wallets/${id}`, { method: 'DELETE' });
      await refreshWallets();
      setNotice('Dompet berhasil dihapus.');
    } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const currentTransactionPayload = JSON.stringify({
    walletId,
    type: transactionType,
    amount: amount.trim(),
      sourceId: sourceId || null,
    category: category.trim(),
    notes: notes.trim(),
    transactionDate,
  });
  const canRetryPending = Boolean(
    pendingKey && transactionAttempt.current?.key === pendingKey &&
    transactionAttempt.current.payload === currentTransactionPayload
  );

  const createTransaction = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !walletId || !financeUserId || !canStoreTransactions) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const payload = currentTransactionPayload;
    try {
      const markerCleared = await withTransactionLock(financeUserId, async () => {
        await assertFinanceUser(financeUserId);
        let key = readPendingKey(financeUserId);
        const sameAttempt =
          key &&
          transactionAttempt.current?.key === key &&
          transactionAttempt.current.payload === payload;
        if (key && !sameAttempt) {
          setPendingKey(key);
          throw new Error(
            'Masih ada transaksi yang belum pasti. Periksa hasilnya sebelum membuat transaksi lain.'
          );
        }
        if (!key) {
          key = crypto.randomUUID();
          window.localStorage.setItem(pendingStorageKey(financeUserId), key);
          setPendingKey(key);
        }
        transactionAttempt.current = { payload, key };
        await request('/api/finance/transactions', {
          method: 'POST',
          headers: { 'Idempotency-Key': key, 'X-Finance-Actor': financeUserId },
          body: payload,
        });
        try {
          if (readPendingKey(financeUserId) !== key) throw new Error('Penanda transaksi berubah.');
          window.localStorage.removeItem(pendingStorageKey(financeUserId));
          setPendingKey(null);
          setRecovered(null);
          setRecoveryChecked(false);
          transactionAttempt.current = null;
          return true;
        } catch {
          setPendingKey(key);
          return false;
        }
      });
      setAmount('');
      setCategory('');
      setNotes('');
      try {
        await Promise.all([refreshWallets(), refreshTransactions(), refreshSummary()]);
        setNotice(
          markerCleared
            ? 'Transaksi berhasil disimpan.'
            : 'Transaksi berhasil disimpan. Periksa penanda pemulihan sebelum membuat transaksi lain.'
        );
      } catch (cause) {
        reportError(cause);
        setNotice(
          'Transaksi berhasil disimpan, tetapi daftar belum dapat diperbarui. Muat ulang halaman untuk melihatnya.'
        );
      }
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const saveTransactionEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingTransactionId || !financeUserId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await assertFinanceUser(financeUserId);
      await request(`/api/finance/transactions/${editingTransactionId}`, {
        method: 'PATCH',
        headers: { 'X-Finance-Actor': financeUserId },
        body: JSON.stringify({
          type: transactionType, amount: amount.trim(), category: category.trim(),
          notes: notes.trim(), transactionDate, sourceId: sourceId || null,
        }),
      });
      setEditingTransactionId(null);
      setAmount(''); setCategory(''); setNotes('');
      await Promise.all([refreshWallets(), refreshTransactions(), refreshSummary()]);
      setNotice('Transaksi berhasil diperbarui.');
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const beginTransactionEdit = (transaction: Transaction) => {
    setEditingTransactionId(transaction.id);
    setTransactionType(transaction.type);
    setSourceId(transaction.sourceId ?? '');
    setAmount(transaction.amount);
    setCategory(transaction.category ?? '');
    setNotes(transaction.notes ?? '');
    setTransactionDate(transaction.transactionDate ?? todayLocal());
    transactionFormRef.current?.setAttribute('open', '');
  };

  const cancelTransactionEdit = () => {
    setEditingTransactionId(null);
    transactionFormRef.current?.removeAttribute('open');
  };

  const removeTransaction = async (id: string) => {
    if (!financeUserId || busyRef.current || !window.confirm('Hapus transaksi ini dari buku? Saldo dompet akan dihitung ulang.')) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await assertFinanceUser(financeUserId);
      await request(`/api/finance/transactions/${id}`, {
        method: 'DELETE', headers: { 'X-Finance-Actor': financeUserId },
      });
      await Promise.all([refreshWallets(), refreshTransactions(), refreshSummary()]);
      setNotice('Transaksi dihapus dari buku dan saldonya dihitung ulang.');
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const checkRecovery = async () => {
    if (busyRef.current || !financeUserId || !canStoreTransactions) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await withTransactionLock(financeUserId, async () => {
        await assertFinanceUser(financeUserId);
        const key = readPendingKey(financeUserId);
        if (!key) {
          setPendingKey(null);
          setRecovered(null);
          setRecoveryChecked(false);
          return;
        }
        const result = await request<{ transaction: RecoveredTransaction | null }>(
          `/api/finance/transactions?requestKey=${encodeURIComponent(key)}`,
          { headers: { 'X-Finance-Actor': financeUserId } }
        );
        setPendingKey(key);
        setRecovered(result.transaction);
        setRecoveryChecked(true);
      });
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const acknowledgeRecovery = async () => {
    if (busyRef.current || !financeUserId || !canStoreTransactions || !recovered) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await withTransactionLock(financeUserId, async () => {
        await assertFinanceUser(financeUserId);
        const key = readPendingKey(financeUserId);
        if (!key) throw new Error('Penanda transaksi tidak ditemukan.');
        const result = await request<{ transaction: RecoveredTransaction | null }>(
          `/api/finance/transactions?requestKey=${encodeURIComponent(key)}`,
          { headers: { 'X-Finance-Actor': financeUserId } }
        );
        if (!result.transaction || result.transaction.id !== recovered.id)
          throw new Error('Transaksi belum dapat dipastikan. Periksa lagi.');
        window.localStorage.removeItem(pendingStorageKey(financeUserId));
        transactionAttempt.current = null;
        setPendingKey(null);
        setRecovered(null);
        setRecoveryChecked(false);
      });
      setNotice('Hasil transaksi terkonfirmasi.');
      try {
        await Promise.all([refreshWallets(), refreshTransactions(), refreshSummary()]);
      } catch (cause) {
        reportError(cause);
      }
    } catch (cause) {
      reportError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const selectedWallet = wallets.find((wallet) => wallet.id === walletId);
  const selectedGroup = groups.find((group) => group.id === groupId);
  return (
    <div className={styles.page} lang="id">
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <p className={styles.brand}>Hall of Achievements</p>
          <nav className={styles.nav} aria-label="Navigasi utama">
            <Link href="/">Kembali ke galeri</Link>
            {session?.authenticated && (
              <button
                className={`${styles.button} ${styles.quiet}`}
                disabled={busy}
                onClick={() => void signOut()}
              >
                Keluar akun keuangan
              </button>
            )}
          </nav>
        </div>
      </header>
      <main className={styles.main}>
        <div className={styles.intro}>
          <div>
            <h1 className={styles.heading}>Keuangan bersama</h1>
            <p className={styles.subtle}>Atur grup, dompet, dan catatan transaksi Anda.</p>
          </div>
          {session?.user && (
            <p className={styles.subtle}>
              Masuk sebagai <strong>{session.user.username}</strong>
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className={styles.notice}>
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className={styles.status}>
            {notice}
          </p>
        )}
        {sessionLoading ? (
          <p role="status" className={styles.subtle}>
            Memeriksa sesi…
          </p>
        ) : !session ? (
          <div className={`${styles.panel} ${styles.auth}`}>
            <p className={styles.subtle}>Sesi keuangan belum dapat diperiksa.</p>
            <button className={styles.button} onClick={() => void refreshSession()}>
              Coba lagi
            </button>
          </div>
        ) : !session.authenticated ? (
          <section
            className={`${styles.panel} ${styles.auth}`}
            aria-labelledby="finance-login-heading"
          >
            <h2 id="finance-login-heading" className={styles.sectionHeading}>
              {register ? (inviteToken ? 'Gabung grup keuangan' : 'Buat akun keuangan pertama') : 'Masuk ke akun keuangan'}
            </h2>
            <p className={styles.subtle}>
              {register
                ? inviteToken ? 'Buat akun keuangan melalui undangan grup.' : 'Pembuatan akun pertama memerlukan sesi pemilik Hall.'
                : 'Gunakan akun keuangan Anda untuk membuka grup dan dompet.'}
            </p>
            <form className={styles.form} onSubmit={(event) => void signIn(event)}>
              <label>
                Nama pengguna
                <input
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={50}
                  pattern="[A-Za-z0-9_.-]+"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <small className={styles.subtle}>
                  3–50 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.
                </small>
              </label>
              <label>
                Kata sandi
                <input
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  minLength={register ? 12 : undefined}
                  maxLength={256}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {register && <small className={styles.subtle}>Minimal 12 karakter.</small>}
              </label>
              <button className={styles.button} disabled={busy}>
                {busy ? 'Memproses…' : register ? 'Buat akun' : 'Masuk'}
              </button>
            </form>
            <button
              type="button"
              className={`${styles.button} ${styles.quiet}`}
              style={{ marginTop: 12 }}
              disabled={busy}
              onClick={() => {
                setRegister(!register);
                if (register) setInviteToken(null);
                setError(null);
                setPassword('');
              }}
            >
              {register ? 'Sudah punya akun? Masuk' : 'Buat akun atau gabung grup'}
            </button>
          </section>
        ) : (
          <div className={styles.grid}>
            <section className={styles.panel} aria-labelledby="profile-heading">
              <h2 id="profile-heading" className={styles.sectionHeading}>Profil</h2>
              <p>{session.user?.username}</p>
              {session.user?.profilePicture && <img src={session.user.profilePicture} width={96} height={96} alt="Foto profil Anda" />}
              <form className={styles.form} onSubmit={(event) => void saveProfilePicture(event)}>
                <label>Foto profil (JPEG, PNG, WebP, atau JPEG XL, maksimal 2 MB)<input type="file" accept="image/jpeg,image/png,image/webp,image/jxl,.jxl" required disabled={busy} onChange={(event) => setProfileFile(event.target.files?.[0] ?? null)} /></label>
                <button className={styles.button} disabled={busy || !profileFile}>Simpan foto</button>
              </form>
              {session.user?.profilePicture && <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void removeProfilePicture()}>Hapus foto</button>}
            </section>
            <section className={styles.panel} aria-labelledby="groups-heading">
              <div className={styles.panelHeader}>
                <h2 id="groups-heading" className={styles.sectionHeading}>
                  Grup
                </h2>
              </div>
              {groupsLoading ? (
                <p role="status" className={styles.empty}>
                  Memuat grup…
                </p>
              ) : groups.length ? (
                <label className={styles.form}>
                  Grup aktif
                  <select
                    className={styles.select}
                    disabled={busy}
                    value={groupId}
                    onChange={(event) => setGroupId(event.target.value)}
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className={styles.empty}>
                  Belum ada grup. Buat grup untuk mulai mengatur dompet.
                </p>
              )}
              <details className={styles.details}>
                <summary>Buat grup</summary>
                <form className={styles.form} onSubmit={(event) => void createGroup(event)}>
                  <label>
                    Nama grup
                    <input
                      required
                      disabled={busy}
                      maxLength={120}
                      value={groupName}
                      onChange={(event) => setGroupName(event.target.value)}
                    />
                  </label>
                  <button className={styles.button} disabled={busy}>
                    Simpan grup
                  </button>
                </form>
              </details>
              {groupId && ['owner', 'admin'].includes(selectedGroup?.role ?? '') && (
                <details className={styles.details}>
                  <summary>Kelola grup</summary>
                  <form className={styles.form} onSubmit={(event) => void renameGroup(event)}>
                    <label>Nama grup<input required maxLength={120} disabled={busy} value={groupRename} onChange={(event) => setGroupRename(event.target.value)} /></label>
                    <button className={styles.button} disabled={busy}>Simpan nama grup</button>
                  </form>
                  {selectedGroup?.role === 'owner' && <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void removeGroup()}>Hapus grup kosong</button>}
                </details>
              )}
              {groupId && (
                <div className={styles.details}>
                  <h3 className={styles.sectionHeading}>Anggota</h3>
                  <ul className={styles.list}>
                    {members.map((member) => (
                      <li className={styles.row} key={member.id}>
                        <div><strong>{member.username}</strong><small>{member.role}</small></div>
                        <div className={styles.rowActions}>
                          {selectedGroup?.role === 'owner' && member.role !== 'owner' && (
                            <label className={styles.inlineField}>Peran<select aria-label={`Peran ${member.username}`} disabled={busy} value={member.role} onChange={(event) => void changeMemberRole(member, event.target.value as 'admin' | 'member')}><option value="member">Anggota</option><option value="admin">Admin</option></select></label>
                          )}
                          {member.role !== 'owner' && (selectedGroup?.role === 'owner' || (selectedGroup?.role === 'admin' && member.role === 'member')) && (
                            <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void removeMember(member)}>Keluarkan</button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {(groups.find((group) => group.id === groupId)?.role === 'owner' ||
                    groups.find((group) => group.id === groupId)?.role === 'admin') && (
                    <>
                      <button className={styles.button} disabled={busy} onClick={() => void createInvitation()}>
                        Buat undangan anggota
                      </button>
                      <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void revokeInvitations()}>Cabut semua undangan aktif</button>
                      {inviteUrl && (
                        <div className={styles.form}>
                          <label>
                            Tautan undangan (berlaku 7 hari, sekali pakai)
                            <input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
                          </label>
                          <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={() => void copyInvitation()}>
                            Salin tautan
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {groupId && (
                <div className={styles.details}>
                  <h3 className={styles.sectionHeading}>Ringkasan bulan ini</h3>
                  {summary ? (
                    <dl className={styles.list}>
                      <div className={styles.row}><dt>Pemasukan</dt><dd className={styles.amount}>{formatAmount(summary.totalIncome)}</dd></div>
                      <div className={styles.row}><dt>Pengeluaran</dt><dd className={styles.amount}>{formatAmount(summary.totalExpense)}</dd></div>
                      <div className={styles.row}><dt>Selisih</dt><dd className={styles.amount}>{formatAmount(summary.balance)}</dd></div>
                      {summary.budgetRemaining !== null && <div className={styles.row}><dt>Sisa anggaran</dt><dd className={styles.amount}>{formatAmount(summary.budgetRemaining)}</dd></div>}
                    </dl>
                  ) : <p role="status" className={styles.subtle}>Memuat ringkasan…</p>}
                  <p className={styles.subtle}>Anggaran {budget.enabled ? `aktif · ${formatAmount(budget.monthlyLimit ?? '0.00')}` : 'nonaktif'}</p>
                  <a className={styles.button} href={`/api/finance/export?groupId=${encodeURIComponent(groupId)}`} download>
                    Unduh transaksi CSV
                  </a>
                  {['owner', 'admin'].includes(groups.find((group) => group.id === groupId)?.role ?? '') && (
                    <form className={styles.form} onSubmit={(event) => void saveGroupBudget(event)}>
                      <label>
                        Batas bulanan (rupiah)
                        <input inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={budgetInput} onChange={(event) => setBudgetInput(event.target.value)} placeholder="Contoh: 2000000" />
                      </label>
                      <label className={styles.confirmation}>
                        <input type="checkbox" checked={budgetEnabledInput} onChange={(event) => setBudgetEnabledInput(event.target.checked)} />
                        Aktifkan anggaran
                      </label>
                      <button className={`${styles.button} ${styles.quiet}`} disabled={busy}>Simpan anggaran</button>
                    </form>
                  )}
                  <h3 className={styles.sectionHeading}>Sumber transaksi</h3>
                  {sources.length ? (
                    <ul className={styles.list}>{sources.map((source) => <li key={source.id} className={styles.row}>
                      <div><strong>{source.name}</strong><small>{source.type}</small></div>
                      {['owner', 'admin'].includes(selectedGroup?.role ?? '') && <div className={styles.rowActions}>
                        <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => { setEditingSourceId(source.id); setSourceName(source.name); setSourceType(source.type); }}>Ubah</button>
                        <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void removeFinanceSource(source)}>Nonaktifkan</button>
                      </div>}
                      {editingSourceId === source.id && <form className={styles.form} onSubmit={(event) => void saveFinanceSource(event)}>
                        <label>Nama sumber<input required maxLength={100} disabled={busy} value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label>
                        <label>Jenis sumber<select disabled={busy} value={sourceType} onChange={(event) => setSourceType(event.target.value as FinanceSource['type'])}><option value="cash">Tunai</option><option value="e-wallet">Dompet digital</option><option value="bank">Bank</option><option value="other">Lainnya</option></select></label>
                        <div className={styles.rowActions}><button className={styles.button} disabled={busy}>Simpan sumber</button><button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => setEditingSourceId(null)}>Batal</button></div>
                      </form>}
                    </li>)}</ul>
                  ) : <p className={styles.empty}>Belum ada sumber transaksi.</p>}
                  {['owner', 'admin'].includes(groups.find((group) => group.id === groupId)?.role ?? '') && (
                    <details className={styles.details}>
                      <summary>Tambah sumber transaksi</summary>
                      <form className={styles.form} onSubmit={(event) => void createFinanceSource(event)}>
                        <label>Nama sumber<input required maxLength={100} value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label>
                        <label>Jenis sumber<select value={sourceType} onChange={(event) => setSourceType(event.target.value as FinanceSource['type'])}><option value="cash">Tunai</option><option value="e-wallet">Dompet digital</option><option value="bank">Bank</option><option value="other">Lainnya</option></select></label>
                        <button className={styles.button} disabled={busy}>Simpan sumber</button>
                      </form>
                    </details>
                  )}
                </div>
              )}
            </section>
            <section className={styles.panel} aria-labelledby="wallets-heading">
              <div className={styles.panelHeader}>
                <h2 id="wallets-heading" className={styles.sectionHeading}>
                  Dompet
                </h2>
              </div>
              {!groupId ? (
                <p className={styles.empty}>Pilih atau buat grup terlebih dahulu.</p>
              ) : walletsLoading ? (
                <p role="status" className={styles.empty}>
                  Memuat dompet…
                </p>
              ) : wallets.length ? (
                <>
                  <label className={styles.form}>
                    Dompet aktif
                    <select
                      className={styles.select}
                      disabled={busy}
                      value={walletId}
                      onChange={(event) => {
                        cancelTransactionEdit();
                        setWalletId(event.target.value);
                      }}
                    >
                      {wallets.map((wallet) => (
                        <option key={wallet.id} value={wallet.id}>
                          {wallet.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ul className={styles.list}>
                    {wallets.map((wallet) => (
                      <li className={styles.row} key={wallet.id}>
                        <div>
                          <strong>{wallet.name}</strong>
                          <small>
                            {wallet.type === 'goal' ? 'Tabungan tujuan' : 'Tabungan biasa'}
                            {wallet.targetAmount
                              ? ` · Target ${formatAmount(wallet.targetAmount)}`
                              : ''}
                          </small>
                        </div>
                        <span className={styles.amount}>
                          {wallet.balance != null
                            ? formatAmount(wallet.balance)
                            : 'Saldo belum tersedia'}
                        </span>
                        <div className={styles.rowActions}>
                          <button className={styles.buttonSecondary} disabled={busy} onClick={() => {
                            setEditingWalletId(wallet.id);
                            setWalletName(wallet.name);
                            setWalletType(wallet.type);
                            setTargetAmount(wallet.targetAmount ?? '');
                          }}>Ubah</button>
                          <button className={styles.buttonSecondary} disabled={busy} onClick={() => void removeWallet(wallet.id)}>Hapus</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className={styles.empty}>Belum ada dompet di grup ini.</p>
              )}
              {groupId && (
                <details className={styles.details}>
                  <summary>Buat dompet</summary>
                  <form className={styles.form} onSubmit={(event) => void createWallet(event)}>
                    <label>
                      Nama dompet
                      <input
                        required
                        disabled={busy}
                        maxLength={120}
                        value={walletName}
                        onChange={(event) => setWalletName(event.target.value)}
                      />
                    </label>
                    <label>
                      Jenis
                      <select
                        disabled={busy}
                        value={walletType}
                        onChange={(event) =>
                          setWalletType(event.target.value as 'regular' | 'goal')
                        }
                      >
                        <option value="regular">Tabungan biasa</option>
                        <option value="goal">Tabungan tujuan</option>
                      </select>
                    </label>
                    {walletType === 'goal' && (
                      <label>
                        Target (rupiah)
                        <input
                          disabled={busy}
                          inputMode="decimal"
                          pattern="[0-9]+([.][0-9]{1,2})?"
                          required
                          value={targetAmount}
                          onChange={(event) => setTargetAmount(event.target.value)}
                          placeholder="Contoh: 1000000"
                        />
                      </label>
                    )}
                    <button className={styles.button} disabled={busy}>
                      Simpan dompet
                    </button>
                  </form>
                </details>
              )}
              {editingWalletId && (
                <form className={styles.form} onSubmit={(event) => void saveWallet(event)}>
                  <h3>Ubah pengaturan dompet</h3>
                  <label>Nama dompet<input required disabled={busy} maxLength={120} value={walletName} onChange={(event) => setWalletName(event.target.value)} /></label>
                  <label>Jenis<select disabled={busy} value={walletType} onChange={(event) => setWalletType(event.target.value as 'regular' | 'goal')}><option value="regular">Tabungan biasa</option><option value="goal">Tabungan tujuan</option></select></label>
                  {walletType === 'goal' && <label>Target (rupiah)<input required disabled={busy} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={targetAmount} onChange={(event) => setTargetAmount(event.target.value)} /></label>}
                  <div className={styles.rowActions}><button className={styles.button} disabled={busy}>Simpan perubahan</button><button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => setEditingWalletId(null)}>Batal</button></div>
                </form>
              )}
            </section>
            <section
              className={`${styles.panel} ${styles.wide}`}
              aria-labelledby="transactions-heading"
            >
              <div className={styles.panelHeader}>
                <h2 id="transactions-heading" className={styles.sectionHeading}>
                  Transaksi
                </h2>
                {selectedWallet && <span className={styles.subtle}>{selectedWallet.name}</span>}
              </div>
              {!walletId ? (
                <p className={styles.empty}>Pilih atau buat dompet untuk melihat transaksi.</p>
              ) : transactionsLoading ? (
                <p role="status" className={styles.empty}>
                  Memuat transaksi…
                </p>
              ) : transactions.length ? (
                <ul className={styles.list}>
                  {transactions.map((transaction) => (
                    <li className={styles.row} key={transaction.id}>
                      <div>
                        <strong>
                          {transaction.category ||
                            (transaction.type === 'income' ? 'Pemasukan' : 'Pengeluaran')}
                        </strong>
                        <small>
                          {transaction.notes ||
                            transaction.transactionDate ||
                            (transaction.createdAt
                              ? new Date(transaction.createdAt).toLocaleDateString('id-ID')
                              : '')}
                          {transaction.sourceId ? ` · ${transaction.sourceName ?? sources.find((source) => source.id === transaction.sourceId)?.name ?? 'Sumber'}` : ''}
                        </small>
                      </div>
                      <span className={styles.amount}>
                        {transaction.type === 'expense' ? '− ' : '+ '}
                        {formatAmount(transaction.amount)}
                      </span>
                      <div className={styles.actions}>
                        <button type="button" className={`${styles.button} ${styles.quiet}`} disabled={busy} onClick={() => beginTransactionEdit(transaction)}>
                          Ubah
                        </button>
                        <button type="button" className={`${styles.button} ${styles.quiet}`} disabled={busy} onClick={() => void removeTransaction(transaction.id)}>
                          Hapus
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>Belum ada transaksi untuk dompet ini.</p>
              )}
              {walletId && hasMoreTransactions && (
                <p className={styles.subtle}>
                  Hanya 200 transaksi terbaru yang ditampilkan. Transaksi lebih lama belum dapat
                  dibuka di sini.
                </p>
              )}
              {storageError && (
                <p role="alert" className={styles.notice}>
                  Transaksi baru dinonaktifkan karena pemulihan aman tidak tersedia: {storageError}
                </p>
              )}
              {pendingKey && (
                <div className={styles.notice} role="status">
                  <strong>Ada transaksi yang hasilnya belum dipastikan.</strong>
                  <p>
                    Periksa hasilnya terlebih dahulu. Jika belum ditemukan, transaksi lama mungkin
                    masih diproses. Setelah halaman dimuat ulang, transaksi lain tidak dapat dibuat
                    sampai hasil transaksi ini ditemukan dan dikonfirmasi.
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.quiet}`}
                      disabled={busy || !canStoreTransactions}
                      onClick={() => void checkRecovery()}
                    >
                      Periksa hasil transaksi
                    </button>
                    {recovered && (
                      <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => void acknowledgeRecovery()}
                      >
                        Konfirmasi hasil
                      </button>
                    )}
                  </div>
                  {recoveryChecked &&
                    (recovered ? (
                      <p>
                        Transaksi ditemukan:{' '}
                        {recovered.type === 'income' ? 'Pemasukan' : 'Pengeluaran'}{' '}
                        {formatAmount(recovered.amount)}, tanggal {recovered.transactionDate}.
                        Dompet:{' '}
                        {wallets.find((wallet) => wallet.id === recovered.walletId)?.name ??
                          recovered.walletId}
                        .{' '}
                        {recovered.deletedAt
                          ? 'Transaksi ini sudah dihapus dari buku.'
                          : 'Transaksi ini tersimpan di buku.'}{' '}
                        Konfirmasikan setelah memeriksanya.
                      </p>
                    ) : (
                      <p>
                        Transaksi belum terlihat. Ini belum memastikan bahwa permintaan sebelumnya
                        tidak akan tersimpan.
                      </p>
                    ))}
                </div>
              )}
              {walletId && (
                <details ref={transactionFormRef} className={styles.details}>
                  <summary>{editingTransactionId ? 'Ubah transaksi' : 'Tambah transaksi'}</summary>
                  <form className={styles.form} onSubmit={(event) => void (editingTransactionId ? saveTransactionEdit(event) : createTransaction(event))}>
                    <label>
                      Jenis transaksi
                      <select
                        disabled={busy}
                        value={transactionType}
                        onChange={(event) =>
                          setTransactionType(event.target.value as 'income' | 'expense')
                        }
                      >
                        <option value="income">Pemasukan</option>
                        <option value="expense">Pengeluaran</option>
                      </select>
                    </label>
                    <label>
                      Tanggal transaksi
                      <input
                        type="date"
                        required
                        disabled={busy}
                        value={transactionDate}
                        onChange={(event) => setTransactionDate(event.target.value)}
                      />
                    </label>
                    <label>
                      Sumber pembayaran
                      <select disabled={busy} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                        <option value="">Tanpa sumber</option>
                        {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                      </select>
                    </label>
                    <label>
                      Jumlah (rupiah)
                      <input
                        required
                        disabled={busy}
                        inputMode="decimal"
                        pattern="[0-9]+([.][0-9]{1,2})?"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder="Contoh: 50000"
                      />
                    </label>
                    <label>
                      Kategori
                      <input
                        disabled={busy}
                        maxLength={100}
                        value={category}
                        onChange={(event) => setCategory(event.target.value)}
                      />
                    </label>
                    <label>
                      Catatan
                      <input
                        disabled={busy}
                        maxLength={2000}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                      />
                    </label>
                    <button
                      className={styles.button}
                      disabled={
                        busy ||
                        !canStoreTransactions ||
                        Boolean(recovered) ||
                        Boolean(pendingKey && !canRetryPending)
                      }
                    >
                      {editingTransactionId ? 'Simpan perubahan' : 'Simpan transaksi'}
                    </button>
                    {editingTransactionId && (
                      <button type="button" className={`${styles.button} ${styles.quiet}`} disabled={busy} onClick={() => setEditingTransactionId(null)}>
                        Batal ubah
                      </button>
                    )}
                    <p className={styles.subtle}>
                      Jika hasil belum pasti, coba lagi tanpa mengubah isian selama halaman ini
                      tetap terbuka. Setelah dimuat ulang, periksa hasil transaksi terlebih dahulu.
                    </p>
                  </form>
                </details>
              )}
            </section>
            <section className={`${styles.panel} ${styles.wide}`} aria-labelledby="planner-heading">
              <div className={styles.panelHeader}>
                <h2 id="planner-heading" className={styles.sectionHeading}>Planner</h2>
                <span className={styles.subtle}>Pengingat disimpan sebagai jadwal; tidak ada pesan otomatis yang dikirim.</span>
              </div>
              {plannerLoading ? <p role="status" className={styles.empty}>Memuat planner…</p> : (
                <div className={styles.plannerGrid}>
                  <div>
                    <h3>Catatan</h3>
                    {plannerNotes.length ? <ul className={styles.list}>{plannerNotes.map((note) => (
                      <li className={styles.row} key={note.id}>
                        <div><strong>{note.title}</strong><small>{note.content || 'Tanpa rincian'}{note.targetAt ? ` · ${new Date(note.targetAt).toLocaleString('id-ID')}` : ''}{note.isPinned ? ' · Disematkan' : ''}{note.isCompleted ? ' · Selesai' : ''}</small></div>
                        <div className={styles.rowActions}>
                          <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void updatePlannerNote(note, { isCompleted: !note.isCompleted })}>{note.isCompleted ? 'Buka kembali' : 'Selesaikan'}</button>
                          <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void updatePlannerNote(note, { isPinned: !note.isPinned })}>{note.isPinned ? 'Lepas pin' : 'Sematkan'}</button>
                          <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void removePlannerNote(note)}>Hapus</button>
                        </div>
                        <details className={styles.details}>
                          <summary>Ubah catatan</summary>
                          <form className={styles.form} onSubmit={(event) => {
                            event.preventDefault();
                            const values = new FormData(event.currentTarget);
                            void updatePlannerNote(note, { title: String(values.get('title') ?? '').trim(), content: String(values.get('content') ?? '').trim() || null });
                          }}>
                            <label>Judul<input name="title" required maxLength={200} disabled={busy} defaultValue={note.title} /></label>
                            <label>Rincian<textarea name="content" maxLength={10000} disabled={busy} defaultValue={note.content ?? ''} /></label>
                            <button className={styles.button} disabled={busy}>Simpan perubahan</button>
                          </form>
                        </details>
                      </li>
                    ))}</ul> : <p className={styles.empty}>Belum ada catatan.</p>}
                    <details className={styles.details}>
                      <summary>Tambah catatan</summary>
                      <form className={styles.form} onSubmit={(event) => void createPlannerNote(event)}>
                        <label>Judul<input required maxLength={200} disabled={busy} value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} /></label>
                        <label>Rincian<textarea maxLength={10000} disabled={busy} value={noteContent} onChange={(event) => setNoteContent(event.target.value)} /></label>
                        <label>Target waktu (opsional)<input type="datetime-local" disabled={busy} value={noteTargetAt} onChange={(event) => setNoteTargetAt(event.target.value)} /></label>
                        <button className={styles.button} disabled={busy}>Simpan catatan</button>
                      </form>
                    </details>
                  </div>
                  <div>
                    <h3>Pengingat</h3>
                    <p className={styles.subtle}>Kirim notifikasi secara manual ke perangkat ini saat halaman terbuka. Jadwal tidak mengirim otomatis.</p>
                    {devicePermission === 'default' && <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void enableReminderNotifications()}>Aktifkan notifikasi perangkat</button>}
                    {devicePermission === 'denied' && <p className={styles.subtle}>Izin notifikasi diblokir. Ubah izin melalui pengaturan browser.</p>}
                    {devicePermission === 'unsupported' && <p className={styles.subtle}>Notifikasi perangkat tidak tersedia di browser ini.</p>}
                    {plannerReminders.length ? <ul className={styles.list}>{plannerReminders.map((reminder) => (
                      <li className={styles.row} key={reminder.id}>
                        <div><strong>{plannerNotes.find((note) => note.id === reminder.noteId)?.title ?? 'Catatan'}</strong><small>{new Date(reminder.remindAt).toLocaleString('id-ID')} · {reminder.recurrence === 'none' ? 'Sekali' : `Berulang ${reminder.recurrence}`} · {reminder.status === 'cancelled' ? 'Dibatalkan' : reminder.status === 'sent' ? 'Terkirim' : 'Menunggu'}</small></div>
                        {reminder.status === 'pending' && <div className={styles.rowActions}><button type="button" className={styles.buttonSecondary} disabled={busy || devicePermission !== 'granted'} onClick={() => void sendReminderToDevice(reminder.id)}>Kirim ke perangkat ini</button><button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void cancelPlannerReminder(reminder.id)}>Batalkan</button></div>}
                      </li>
                    ))}</ul> : <p className={styles.empty}>Belum ada pengingat.</p>}
                    {plannerNotes.length > 0 && <details className={styles.details}>
                      <summary>Tambah pengingat</summary>
                      <form className={styles.form} onSubmit={(event) => void createPlannerReminder(event)}>
                        <label>Catatan<select required disabled={busy} value={reminderNoteId} onChange={(event) => setReminderNoteId(event.target.value)}>{plannerNotes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}</select></label>
                        <label>Waktu pengingat<input required type="datetime-local" disabled={busy} value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} /></label>
                        <label>Pengulangan<select disabled={busy} value={reminderRecurrence} onChange={(event) => setReminderRecurrence(event.target.value as typeof reminderRecurrence)}><option value="none">Sekali</option><option value="daily">Harian</option><option value="weekly">Mingguan</option><option value="monthly">Bulanan</option><option value="yearly">Tahunan</option></select></label>
                        <label>Pesan (opsional)<input maxLength={1000} disabled={busy} value={reminderMessage} onChange={(event) => setReminderMessage(event.target.value)} /></label>
                        <button className={styles.button} disabled={busy}>Simpan pengingat</button>
                      </form>
                    </details>}
                  </div>
                  <div>
                    <h3>Tugas terjadwal</h3>
                    {plannerTasks.length ? <ul className={styles.list}>{plannerTasks.map((task) => (
                      <li className={styles.row} key={task.id}>
                        <div><strong>{task.title}</strong><small>{task.details || 'Tanpa rincian'} · {new Date(task.scheduleAt).toLocaleString('id-ID')} · {task.recurrence}</small></div>
                        <div className={styles.rowActions}>
                          <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void updatePlannerTask(task, { completedAt: task.completedAt ? null : new Date().toISOString() })}>{task.completedAt ? 'Buka kembali' : 'Selesaikan'}</button>
                          <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void updatePlannerTask(task, { isActive: !task.isActive })}>{task.isActive ? 'Nonaktifkan' : 'Aktifkan'}</button>
                          <button type="button" className={styles.buttonSecondary} disabled={busy} onClick={() => void removePlannerTask(task)}>Hapus</button>
                        </div>
                      </li>
                    ))}</ul> : <p className={styles.empty}>Belum ada tugas.</p>}
                    <details className={styles.details}>
                      <summary>Tambah tugas</summary>
                      <form className={styles.form} onSubmit={(event) => void createPlannerTask(event)}>
                        <label>Judul<input required maxLength={200} disabled={busy} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
                        <label>Rincian<textarea maxLength={10000} disabled={busy} value={taskDetails} onChange={(event) => setTaskDetails(event.target.value)} /></label>
                        <label>Jadwal<input required type="datetime-local" disabled={busy} value={taskScheduleAt} onChange={(event) => setTaskScheduleAt(event.target.value)} /></label>
                        <label>Pengulangan<select disabled={busy} value={taskRecurrence} onChange={(event) => setTaskRecurrence(event.target.value as typeof taskRecurrence)}><option value="once">Sekali</option><option value="daily">Harian</option><option value="weekly">Mingguan</option><option value="monthly">Bulanan</option></select></label>
                        <button className={styles.button} disabled={busy}>Simpan tugas</button>
                      </form>
                    </details>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
