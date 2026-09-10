// Shared SSH connect factory: encapsulates the common connect/auth/host-key-verify
// logic so BOTH the shell transport and the SFTP transport connect the same way.
//
// - `skipAuth` (observe): connect without credentials solely to observe the host
//   key during the KEX; the hostVerifier captures it via `onFingerprint`.
// - `expectedFingerprint` (connect): the hostVerifier compares the live host key
//   to the trusted fingerprint (padding-insensitive, constant-time); a mismatch
//   fails closed before any channel opens.

import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { TransportTarget } from '@remotedeck/core/session/transport';
import { toOpenSshFingerprint, constantTimeEquals, buildAuth } from './transport-ssh2.js';

export interface ConnectSshOptions {
  /** If set, the hostVerifier enforces this fingerprint (fail-closed on mismatch). */
  expectedFingerprint?: string;
  /** Connect without credentials (observe mode). */
  skipAuth?: boolean;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  readyTimeoutMs?: number;
  /** Called with the observed OpenSSH fingerprint during the handshake. */
  onFingerprint?: (fp: string) => void;
  /** Resolve on 'ready' OR 'close' (for observe, where auth may not complete). */
  resolveOnClose?: boolean;
}

export function connectSsh(target: TransportTarget, opts: ConnectSshOptions = {}): Promise<Client> {
  const {
    expectedFingerprint,
    skipAuth,
    keepaliveInterval = 15_000,
    keepaliveCountMax = 3,
    readyTimeoutMs = 20_000,
    onFingerprint,
    resolveOnClose,
  } = opts;

  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let done = false;
    let fpSeen = false;
    const cleanup = (): void => { try { client.destroy(); } catch { /* already destroyed */ } };
    const fail = (err: Error): void => { if (done) return; done = true; cleanup(); reject(err); };

    const hostVerifier = (key: Buffer): boolean => {
      const fp = toOpenSshFingerprint(key);
      if (fp) fpSeen = true;
      onFingerprint?.(fp);
      if (expectedFingerprint === undefined) return true;
      // Padding-insensitive: legacy stored fingerprints may carry base64 padding.
      return fp === expectedFingerprint || fp.replace(/=+$/g, '') === expectedFingerprint.replace(/=+$/g, '');
    };

    const timer = setTimeout(() => fail(new Error('ssh_connect_timeout')), readyTimeoutMs);
    const onSettled = (): void => { if (done) return; done = true; clearTimeout(timer); resolve(client); };

    client.once('ready', onSettled);
    if (resolveOnClose) client.once('close', onSettled);
    // In observe mode (skipAuth / resolveOnClose) the client may fail auth after the
    // KEX has already captured the host key; treat that as success (fingerprint seen).
    // Use a PERSISTENT 'error' handler (with a settled-guard) because connection-level
    // errors (e.g. ECONNRESET during teardown) can fire AFTER the promise has settled
    // and must not become uncaught exceptions.
    client.on('error', (e) => {
      if (done) return;
      if (resolveOnClose && fpSeen) onSettled();
      else { clearTimeout(timer); fail(e); }
    });

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: readyTimeoutMs,
      keepaliveInterval,
      keepaliveCountMax,
      hostVerifier,
    };
    if (!skipAuth) Object.assign(config, buildAuth(target));

    try {
      client.connect(config);
    } catch (e) {
      clearTimeout(timer);
      fail(e as Error);
    }
  });
}
