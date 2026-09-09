// Config resolution + fail-closed validation for core-server.

export interface ResolvedConfig {
  port: number;
  dbPath: string;
  logLevel: string;
  /** 64 hex chars (32 bytes) used for AES-256-GCM. Required, fail closed. */
  masterKey: string;
  /** API bearer token. Required, minimum length enforced. Fail closed. */
  apiToken: string;
  /** Explicit CORS allow-list. Empty => same-origin only. */
  allowedOrigins: string[];
}

export const MIN_API_TOKEN_LENGTH = 32;

const MASTER_KEY_RE = /^[0-9a-f]{64}$/i;

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const masterKey = (env.REMOTEDECK_MASTER_KEY ?? '').trim();
  if (!MASTER_KEY_RE.test(masterKey)) {
    throw new Error(
      'REMOTEDECK_MASTER_KEY must be a 64-hex-char (32-byte) key. Refusing to start (fail closed).'
    );
  }

  const apiToken = (env.REMOTEDECK_API_TOKEN ?? '').trim();
  if (apiToken.length < MIN_API_TOKEN_LENGTH) {
    throw new Error(
      `REMOTEDECK_API_TOKEN is required and must be at least ${MIN_API_TOKEN_LENGTH} characters. Refusing to start (fail closed).`
    );
  }

  const allowedOrigins = (env.REMOTEDECK_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    port: parseInt(env.PORT || '4100', 10),
    dbPath: env.DATABASE_PATH || './data/remotedeck.db',
    logLevel: env.LOG_LEVEL || 'info',
    masterKey,
    apiToken,
    allowedOrigins,
  };
}
