/**
 * fetch com timeout, retries e backoff que honra `Retry-After`.
 * (Os SDKs não retentam sozinhos — política explícita aqui.)
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, url, detail) {
    super(`HTTP ${status} em ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = String(url);
    this.detail = detail;
  }
}

export class RequestError extends Error {
  constructor(message, url) {
    super(`${message} (${url})`);
    this.name = "RequestError";
    this.url = String(url);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function retryDelayMs(attempt, retryAfter) {
  if (retryAfter) {
    const secs = Number.parseFloat(retryAfter);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0.5) * 1000, 15_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 500), 15_000);
  }
  return Math.min(400 * 2 ** attempt + Math.random() * 250, 8000);
}

/**
 * @returns {{status:number, data:any, headers:Headers}}
 */
export async function request(
  url,
  {
    method = "GET",
    headers = {},
    query,
    json,
    form,
    body,
    timeoutMs = 30_000,
    retries = 2,
    signal,
  } = {},
) {
  const target = new URL(url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        target.searchParams.set(key, String(value));
      }
    }
  }

  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["content-type"] = "application/json";
  } else if (form !== undefined) {
    init.body = form; // FormData: o fetch define o boundary
  } else if (body !== undefined) {
    init.body = body;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(target, { ...init, signal: controller.signal });
      const text = await res.text();
      const data = text ? safeJson(text) : null;

      if (res.ok) {
        return { status: res.status, data, headers: res.headers };
      }

      const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (retriable && attempt < retries) {
        lastError = new HttpError(res.status, target, data ?? text);
        await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
        continue;
      }
      throw new HttpError(res.status, target, data ?? text);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt < retries) {
        lastError = err;
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw new RequestError(err?.message ?? String(err), target);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError;
}

export async function fetchJson(url, options) {
  const { data } = await request(url, options);
  return data;
}