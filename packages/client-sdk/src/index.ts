export interface ClientConfig {
  baseUrl: string;
  token: string;
}

export class RemoteDeckClient {
  private baseUrl: string;
  private token: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  async health(): Promise<{ status: string; timestamp: string }> {
    const res = await fetch(`${this.baseUrl}/healthz`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    const data = await res.json() as { status: string; timestamp: string };
    return data;
  }

  async status(): Promise<{ status: string; version: string; uptime: number }> {
    const res = await fetch(`${this.baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
    const data = await res.json() as { status: string; version: string; uptime: number };
    return data;
  }

  wsUrl(sessionId: string, role: 'writer' | 'viewer'): string {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return `${wsBase}/ws/v1/sessions/${sessionId}?role=${role}&token=${this.token}`;
  }
}
