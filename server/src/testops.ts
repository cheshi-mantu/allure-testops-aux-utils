/** Minimal Allure TestOps REST client. */

const PAGE_SIZE = 1000;
/** Requests to one instance at a time, unless a job asks for another number. */
export const MAX_PARALLEL_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 120_000;
/** Reads are repeated after server errors; writes never are (see `post`). */
const READ_ATTEMPTS = 4;

export interface Page<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  last?: boolean;
}

export interface ApiProject {
  id: number;
  name: string;
}

export class TestOpsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The server failed rather than rejected the request: a read may be repeated. */
    readonly transient = false,
  ) {
    super(message);
  }
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

type Auth = { header: string; expiresAt: number };

export class TestOpsClient {
  private auth: Auth | null = null;
  private authPending: Promise<Auth> | null = null;
  private readonly slots: Semaphore;

  constructor(
    readonly endpoint: string,
    private readonly token: string,
    readonly parallel = MAX_PARALLEL_REQUESTS,
  ) {
    this.slots = new Semaphore(parallel);
  }

  /** A client of the same instance making up to `parallel` requests at a time. */
  withParallel(parallel: number): TestOpsClient {
    return parallel === this.parallel ? this : new TestOpsClient(this.endpoint, this.token, parallel);
  }

  async projects(): Promise<ApiProject[]> {
    return this.all<ApiProject>("/api/rs/project", { sort: "name,asc" });
  }

  /** Accepts both a Spring page and a plain array. */
  async all<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const result: T[] = [];
    for (let page = 0; ; page++) {
      const p = await this.get<Page<T> | T[]>(path, { ...params, page: String(page), size: String(PAGE_SIZE) });
      if (Array.isArray(p)) return p;
      result.push(...p.content);
      if (p.last ?? page + 1 >= p.totalPages) return result;
      if (p.content.length === 0) return result;
    }
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const res = await this.read(path, params, "application/json");
    return (await res.json()) as T;
  }

  /** Binary content, e.g. an attachment. */
  async download(path: string): Promise<Buffer> {
    const res = await this.read(path, {}, "*/*");
    return Buffer.from(await res.arrayBuffer());
  }

  /** Sends a JSON body once: after a server error the write may have happened. */
  async post<T>(path: string, body: unknown): Promise<T | null> {
    const res = await this.slots.run(() => this.send("POST", new URL(this.endpoint + path), "application/json", body));
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  async patch<T>(path: string, body: unknown): Promise<T | null> {
    return this.write<T>("PATCH", path, body);
  }

  async delete(path: string): Promise<void> {
    await this.write("DELETE", path);
  }

  private async write<T>(method: "PATCH" | "DELETE", path: string, body?: unknown): Promise<T | null> {
    const res = await this.slots.run(() => this.send(method, new URL(this.endpoint + path), "application/json", body));
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  private async read(path: string, params: Record<string, string>, accept: string): Promise<Response> {
    const url = new URL(this.endpoint + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.slots.run(async () => {
          const res = await this.send("GET", url, accept);
          // An HTML page instead of JSON means the request did not reach the API.
          if (accept === "application/json" && (res.headers.get("content-type") ?? "").includes("text/html")) {
            await res.body?.cancel();
            throw new TestOpsError(`Allure TestOps answered GET ${url.pathname} with an HTML page instead of JSON`, res.status, true);
          }
          return res;
        });
      } catch (e) {
        if (!(e instanceof TestOpsError) || !e.transient || attempt >= READ_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  private async send(method: "GET" | "POST" | "PATCH" | "DELETE", url: URL, accept: string, body?: unknown): Promise<Response> {
    let res = await this.fetchWithAuth(method, url, accept, body);
    if (res.status === 401) {
      this.auth = null;
      res = await this.fetchWithAuth(method, url, accept, body);
    }
    if (!res.ok) {
      const transient = res.status >= 500 || res.status === 429;
      throw new TestOpsError(`${res.status} ${res.statusText} for ${method} ${url.pathname}${await errorDetails(res)}`, res.status, transient);
    }
    return res;
  }

  private async fetchWithAuth(method: string, url: URL, accept: string, body?: unknown): Promise<Response> {
    const auth = await this.authorize();
    const headers: Record<string, string> = { Authorization: auth.header, Accept: accept };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return timedFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  private async authorize(): Promise<Auth> {
    if (this.auth && this.auth.expiresAt > Date.now()) return this.auth;
    this.authPending ??= this.login().finally(() => (this.authPending = null));
    this.auth = await this.authPending;
    return this.auth;
  }

  /**
   * Exchanges the API token for a JWT. If the exchange fails with anything
   * but an authentication error, the token is sent as is.
   */
  private async login(): Promise<Auth> {
    const res = await timedFetch(new URL(this.endpoint + "/api/uaa/oauth/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "apitoken", scope: "openid", token: this.token }),
    });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (body.access_token) {
        const ttl = Math.max(60, (body.expires_in ?? 3600) - 60);
        return { header: `Bearer ${body.access_token}`, expiresAt: Date.now() + ttl * 1000 };
      }
    }
    if (res.status === 400 || res.status === 401) {
      throw new TestOpsError(`Allure TestOps rejected the API token (${res.status})${await errorDetails(res)}`, res.status);
    }
    return { header: `Api-Token ${this.token}`, expiresAt: Number.MAX_SAFE_INTEGER };
  }
}

async function timedFetch(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
    throw new TestOpsError(`Cannot reach ${url.origin}${cause || (e instanceof Error ? `: ${e.message}` : "")}`, undefined, true);
  }
}

async function errorDetails(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text) as { message?: string; error_description?: string; error?: string };
    const msg = body.message ?? body.error_description ?? body.error;
    return msg ? `: ${msg}` : "";
  } catch {
    return text.trimStart().startsWith("<") ? "" : `: ${text.slice(0, 200)}`;
  }
}
