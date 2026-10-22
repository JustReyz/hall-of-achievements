import { createSession } from '@/lib/auth/session';

export interface AuthenticatedHeaders extends Record<string, string> {
  cookie: string;
  'content-type': string;
  'x-requested-with': string;
  origin: string;
}

export async function createAuthenticatedHeaders(): Promise<{
  headers: AuthenticatedHeaders;
  rawToken: string;
}> {
  const { rawToken } = await createSession();
  const headers: AuthenticatedHeaders = {
    cookie: `__Host-session=${rawToken}`,
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: 'http://localhost:3000',
  };
  return { headers, rawToken };
}
