import type { CreateCredentialRequest } from '@remotedeck/api';

export type NewCredentialDraft = {
  enabled: boolean;
  name: string;
  type: 'password' | 'key' | 'agent';
  secret: string;
};

export function emptyCredentialDraft(): NewCredentialDraft {
  return { enabled: false, name: '', type: 'password', secret: '' };
}

/** Build only fields accepted by the API. Callers should clear draft.secret immediately after this. */
export function buildCredentialRequest(draft: NewCredentialDraft): CreateCredentialRequest | null {
  if (!draft.enabled) return null;
  const name = draft.name.trim();
  if (!name) throw new Error('자격 증명 이름을 입력해 주세요.');
  if (draft.type !== 'agent' && !draft.secret) {
    throw new Error(draft.type === 'key' ? '개인 키를 입력해 주세요.' : '비밀번호를 입력해 주세요.');
  }
  return draft.type === 'agent'
    ? { name, type: 'agent' }
    : { name, type: draft.type, secret: draft.secret };
}
