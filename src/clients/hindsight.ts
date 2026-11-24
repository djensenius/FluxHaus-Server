import logger from '../logger';

// Never log request/response bodies, the app key, or memory content here —
// only operation names, HTTP status codes, and durations.
const hindsightLogger = logger.child({ subsystem: 'hindsight' });

export const DEFAULT_HINDSIGHT_TIMEOUT_MS = 4000;
export const DEFAULT_HINDSIGHT_BANK = 'shared';

export interface HindsightConfig {
  url: string;
  appKey: string;
  allowedIssuers: string[];
  bank?: string;
  timeoutMs?: number;
}

export interface HindsightMemory {
  id?: string;
  text: string;
  type?: string;
}

export class HindsightError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HindsightError';
    this.status = status;
  }
}

const normalizeIssuer = (issuer: string): string => issuer.trim().replace(/\/+$/, '');

export class HindsightClient {
  private readonly baseUrl: string;

  private readonly appKey: string;

  private readonly bank: string;

  private readonly timeoutMs: number;

  private readonly allowedIssuers: Set<string>;

  private readonly ensuredSubjects = new Set<string>();

  constructor(config: HindsightConfig) {
    this.baseUrl = (config.url || '').trim().replace(/\/+$/, '');
    this.appKey = (config.appKey || '').trim();
    this.bank = (config.bank || '').trim() || DEFAULT_HINDSIGHT_BANK;
    this.timeoutMs = config.timeoutMs && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_HINDSIGHT_TIMEOUT_MS;
    this.allowedIssuers = new Set(
      (config.allowedIssuers || []).map(normalizeIssuer).filter(Boolean),
    );
  }

  /** Feature is enabled only when URL, app key, and allowed issuers are all set. */
  get configured(): boolean {
    return !!this.baseUrl && !!this.appKey && this.allowedIssuers.size > 0;
  }

  isIssuerAllowed(issuer?: string): boolean {
    if (!issuer) return false;
    return this.allowedIssuers.has(normalizeIssuer(issuer));
  }

  private bankPath(suffix = ''): string {
    return `/v1/default/banks/${encodeURIComponent(this.bank)}${suffix}`;
  }

  private async request(
    op: string,
    method: 'PUT' | 'POST',
    path: string,
    subject: string,
    body: unknown,
  ): Promise<Response> {
    if (!this.configured) throw new HindsightError('Hindsight is not configured');
    if (!subject) throw new HindsightError('Hindsight subject is required');
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.appKey}`,
          'X-Hindsight-Subject': subject,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'Error';
      hindsightLogger.warn({ op, reason, ms: Date.now() - started }, 'Hindsight request failed');
      throw new HindsightError(`Hindsight ${op} failed`);
    }
    hindsightLogger.debug({ op, status: response.status, ms: Date.now() - started }, 'Hindsight request');
    return response;
  }

  private async ensureBank(subject: string): Promise<void> {
    if (this.ensuredSubjects.has(subject)) return;
    const res = await this.request('ensure_bank', 'PUT', this.bankPath(), subject, {
      name: 'Shared personal memory',
    });
    if (!res.ok) {
      hindsightLogger.warn({ op: 'ensure_bank', status: res.status }, 'Hindsight bank ensure failed');
      throw new HindsightError(`Hindsight ensure_bank failed: ${res.status}`, res.status);
    }
    this.ensuredSubjects.add(subject);
  }

  async recall(subject: string, query: string): Promise<HindsightMemory[]> {
    const res = await this.request('recall', 'POST', this.bankPath('/memories/recall'), subject, {
      query,
      budget: 'low',
      max_tokens: 1024,
    });
    if (res.status === 404) {
      // Bank not created yet for this subject — create it and report nothing.
      this.ensuredSubjects.delete(subject);
      await this.ensureBank(subject);
      return [];
    }
    if (!res.ok) {
      hindsightLogger.warn({ op: 'recall', status: res.status }, 'Hindsight recall failed');
      throw new HindsightError(`Hindsight recall failed: ${res.status}`, res.status);
    }
    const data = (await res.json()) as { results?: unknown };
    const results = Array.isArray(data?.results) ? data.results : [];
    const memories = results
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object'
        && typeof (r as Record<string, unknown>).text === 'string')
      .map((r) => ({
        id: typeof r.id === 'string' ? r.id : undefined,
        text: r.text as string,
        type: typeof r.type === 'string' ? r.type : undefined,
      }));
    hindsightLogger.info({ op: 'recall', count: memories.length }, 'Hindsight recall complete');
    return memories;
  }

  async retain(subject: string, content: string): Promise<void> {
    await this.ensureBank(subject);
    const res = await this.request('retain', 'POST', this.bankPath('/memories'), subject, {
      items: [{
        content,
        context: 'fluxhaus',
        tags: ['source:fluxhaus'],
        metadata: { source: 'fluxhaus' },
      }],
      async: true,
    });
    if (!res.ok) {
      if (res.status === 404) this.ensuredSubjects.delete(subject);
      hindsightLogger.warn({ op: 'retain', status: res.status }, 'Hindsight retain failed');
      throw new HindsightError(`Hindsight retain failed: ${res.status}`, res.status);
    }
    hindsightLogger.info({ op: 'retain', status: res.status }, 'Hindsight retain queued');
  }
}

export function parseHindsightTimeout(raw?: string): number {
  const n = Number((raw || '').trim());
  // Keep well under the 30s AI tool timeout.
  return Number.isFinite(n) && n > 0 ? Math.min(n, 25_000) : DEFAULT_HINDSIGHT_TIMEOUT_MS;
}

export function parseAllowedIssuers(raw?: string): string[] {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}
