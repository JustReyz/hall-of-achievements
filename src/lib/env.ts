import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').refine(
    (url) => url.startsWith('postgres://') || url.startsWith('postgresql://'),
    { message: 'DATABASE_URL must be a valid PostgreSQL connection string' }
  ),
  OWNER_ACCESS_CODE: z.string().min(32, {
    message: 'OWNER_ACCESS_CODE must have at least 128 bits entropy (>= 32 characters)',
  }),
  SESSION_VERSION_KEY: z
    .string()
    .min(64, {
      message: 'SESSION_VERSION_KEY must have at least 256 bits entropy (>= 64 hex characters)',
    })
    .regex(/^[0-9a-fA-F]{64,}$/, {
      message: 'SESSION_VERSION_KEY must be a valid hex string of at least 64 characters',
    }),
  RATE_LIMIT_SALT: z.string().min(32, {
    message: 'RATE_LIMIT_SALT must have at least 32 characters',
  }),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((val) => (val !== undefined ? val === 'true' : process.env.NODE_ENV === 'production')),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@hall-of-achievements.local'),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvironmentValidationError extends Error {
  public readonly issues: Array<{ variable: string; code: string; message: string }>;

  constructor(issues: Array<{ variable: string; code: string; message: string }>) {
    super('Environment validation failed. Check server configuration logs.');
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

/**
 * Validates environment variables strictly with zero secret leakage in error output.
 */
export function parseEnv(rawEnv: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    // Zero-leak redactor: only extract variable name, issue code, and sanitized validation message.
    // NEVER include raw values, received strings, or environment dumps.
    const sanitizedIssues = result.error.issues.map((issue) => ({
      variable: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));

    // Log sanitized error details without leaking any secret values
    console.error(
      `[SECURITY ERROR] Environment validation failed:\n${JSON.stringify(sanitizedIssues, null, 2)}`
    );

    throw new EnvironmentValidationError(sanitizedIssues);
  }

  return result.data;
}

// Lazy or safe getter for runtime environment
let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = parseEnv(process.env);
  }
  return cachedEnv;
}

export const env = new Proxy({} as Env, {
  get(_target, prop: string | symbol) {
    const current = getEnv();
    return current[prop as keyof Env];
  },
});
