// Config resolution + fail-closed validation for core-server.
import { isIP } from 'node:net';

export interface ResolvedConfig {
  port: number;
  /** Bind address. Defaults to loopback (127.0.0.1). Must be a valid IP literal. */
  listenHost: string;
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

/** Default bind address: loopback only. Set REMOTEDECK_LISTEN_HOST=0.0.0.0 for Docker/compose. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

const MASTER_KEY_RE = /^[0-9a-f]{64}$/i;

/**
 * Resolve and validate the listen host. Empty/unset => loopback default.
 * Any non-empty value must be a valid IPv4/IPv6 literal; otherwise fail closed.
 * Hostnames are rejected deliberately so the bind address is always deterministic.
 */
function resolveListenHost(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_LISTEN_HOST;
  if (isIP(value) === 0) {
    throw new Error(
      'REMOTEDECK_LISTEN_HOST must be a valid IPv4/IPv6 address literal ' +
      "(e.g. 127.0.0.1 for loopback-only, 0.0.0.0 for all interfaces). Refusing to start (fail closed)."
    );
  }
  return value;
}

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

  const listenHost = resolveListenHost(env.REMOTEDECK_LISTEN_HOST);

  const allowedOrigins = (env.REMOTEDECK_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    port: parseInt(env.PORT || '4100', 10),
    listenHost,
    dbPath: env.DATABASE_PATH || './data/remotedeck.db',
    logLevel: env.LOG_LEVEL || 'info',
    masterKey,
    apiToken,
    allowedOrigins,
  };
}
