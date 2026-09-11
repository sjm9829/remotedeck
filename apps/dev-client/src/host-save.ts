import type { CreateCredentialRequest, CreateHostRequest, UpdateHostRequest } from '@remotedeck/api';
import type { Credential, Host } from '@remotedeck/types';

export type HostSaveClient = {
  createCredential(body: CreateCredentialRequest): Promise<Credential>;
  createHost(body: CreateHostRequest): Promise<Host>;
  updateHost(id: string, body: UpdateHostRequest): Promise<Host>;
};

export async function persistHost(
  client: HostSaveClient,
  hostId: string | null,
  hostBody: CreateHostRequest,
  credentialBody: CreateCredentialRequest | null,
): Promise<Host> {
  const credentialId = credentialBody ? (await client.createCredential(credentialBody)).id : hostBody.credentialId;
  const boundBody = { ...hostBody, credentialId: credentialId ?? null };
  return hostId ? client.updateHost(hostId, boundBody) : client.createHost(boundBody);
}
