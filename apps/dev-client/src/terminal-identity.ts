import type { Host } from '@remotedeck/types';

/** Display metadata such as host.name must never control a live terminal/socket lifecycle. */
export function terminalIdentity(host: Pick<Host, 'id'>): string {
  return host.id;
}
