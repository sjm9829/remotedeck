// Stable SSH connect/observe error classification, shared by the shell transport
// (transport-ssh2) and the SFTP transport (transport-sftp). Maps raw ssh2/network
// errors to stable, non-sensitive codes so the REST layer can return consistent
// HTTP statuses. Sensitive transport detail (host key material, authentication
// specifics, raw socket errors) is normalized here and not propagated to
// responses or logs.
export type SshConnectErrorCode =
  | 'fingerprint_mismatch'
  | 'auth_failed'
  | 'not_supported'
  | 'timeout'
  | 'unreachable';

export type SshConnectError = Error & { code: SshConnectErrorCode };

function withCode(msg: string, code: SshConnectErrorCode): SshConnectError {
  return Object.assign(new Error(msg), { code });
}

export function mapConnectError(err: unknown): SshConnectError {
  const e = err as any;
  const msg: string = typeof e?.message === 'string' ? e.message : String(e?.message ?? 'connection failed');
  const level: string | undefined = e?.level;
  const code: string | undefined = e?.code;
  // Host key rejected by the verifier (ssh2 fatal handshake error, e.g. "Host
  // denied (verification failed)"), or host-key-mismatch wording raised by any
  // other transport layer.
  if (level === 'handshake' || /^host denied/i.test(msg) || /host key mismatch/i.test(msg))
    return withCode('host key fingerprint mismatch', 'fingerprint_mismatch');
  // Authentication failed (wrong password / key / no acceptable method).
  if (level === 'client-authentication' || /authentication.*failed/i.test(msg))
    return withCode('authentication failed', 'auth_failed');
  // No usable credential (thrown by buildAuth / credential mapping before the socket opens).
  if (code === 'not_supported')
    return withCode(msg || 'no usable credential', 'not_supported');
  // Our own ready-timeout guard (or a socket-level TCP timeout).
  if (msg === 'ssh_connect_timeout' || code === 'ETIMEDOUT')
    return withCode('connection timed out', 'timeout');
  // Everything else at connect time is a network/socket-level failure.
  return withCode('host unreachable', 'unreachable');
}
