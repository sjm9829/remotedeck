import type { Store } from '../store.js';
import type { TransportTarget } from './transport.js';

/**
 * Resolve the transport target for a (shell or SFTP) session. The session-level
 * credentialId (override) takes priority over the host's default credential. The
 * credential TYPE decides which field the secret populates:
 *   password -> target.password, key -> target.privateKey.
 * Unsupported shapes (agent, keyPath-only, missing secret) are rejected fail-closed.
 * A host with no credential resolves to a base target (no auth material) and the
 * transport fails closed at connect time.
 */
export function resolveTransportTarget(
  store: Store,
  hostId: string,
  credentialIdOverride: string | null,
): TransportTarget {
  const host = store.getHost(hostId);
  if (!host) { const e = new Error('host_not_found'); (e as any).code = 'not_found'; throw e; }
  const base: TransportTarget = { host: host.hostname, port: host.port, username: host.username };
  const credId = credentialIdOverride ?? host.credentialId ?? null;
  if (!credId) return base;
  const cred = store.getCredential(credId);
  if (!cred) { const e = new Error('credential_not_found'); (e as any).code = 'not_found'; throw e; }
  const secret = store.decryptCredentialSecret(credId); // string | null
  const target: TransportTarget = { ...base };
  switch (cred.type) {
    case 'password':
      if (secret) target.password = secret;
      else { const e = new Error('password credential has no secret'); (e as any).code = 'not_supported'; throw e; }
      break;
    case 'key':
      if (secret) target.privateKey = secret;
      else if (cred.keyPath) {
        const e = new Error('keyPath-only key credential not supported; store the private key as the secret');
        (e as any).code = 'not_supported'; throw e;
      } else {
        const e = new Error('key credential has no secret');
        (e as any).code = 'not_supported'; throw e;
      }
      break;
    case 'agent': {
      const e = new Error('agent credential not supported by the ssh2 transport');
      (e as any).code = 'not_supported'; throw e;
    }
    default: {
      const e = new Error(`unsupported credential type: ${cred.type}`);
      (e as any).code = 'not_supported'; throw e;
    }
  }
  return target;
}
