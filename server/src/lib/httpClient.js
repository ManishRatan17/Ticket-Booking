// Calls to OUTSIDE services (train provider, …): every call has a timeout, safe calls are retried,
// failures are logged in one line, and the caller gets a meaningful error instead of a hang or a 500.
//
//   requestJson({ service: 'train_provider', url, method, headers, body, timeoutMs, retries, idempotent })
//     → { status, data }   for 2xx and 4xx answers (a 404 or a 422 is the caller's business)
//     → throws AppError    504 <SERVICE>_TIMEOUT      no answer within timeoutMs (after retries)
//                          502 <SERVICE>_UNREACHABLE  connection refused / DNS / reset
//                          502 <SERVICE>_ERROR        the service answered 5xx
//                          503 <SERVICE>_BUSY         the service answered 429 (rate limited)
//
// RETRIES only where repeating is safe: GET / HEAD, or a POST the caller marks idempotent (it sends
// an idempotency key the provider honours). A booking POST that timed out may HAVE succeeded:
// retrying it blindly could book twice, so by default it is NOT retried.
// Logs never include headers or bodies (they can hold credentials or passenger data).
import { AppError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function requestJson({
  service,
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 8000,
  retries = 2,
  retryDelayMs = 300,
  idempotent = SAFE_METHODS.has(method),
}) {
  const code = service.toUpperCase();
  const attempts = idempotent ? retries + 1 : 1;
  const where = `${method} ${new URL(url).pathname}`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError';
      lastError = timedOut
        ? new AppError(504, `${code}_TIMEOUT`, `${service} did not answer within ${timeoutMs} ms`)
        : new AppError(502, `${code}_UNREACHABLE`, `Could not reach ${service}`);
      console.warn(`[http] ${service} ${where} → ${timedOut ? `timeout after ${timeoutMs} ms` : `unreachable (${err.cause?.code ?? err.message})`} (attempt ${attempt}/${attempts})`);
    }

    if (res) {
      if (res.status === 429 || res.status >= 500) {
        const busy = res.status === 429;
        lastError = busy
          ? new AppError(503, `${code}_BUSY`, `${service} is busy; try again shortly`)
          : new AppError(502, `${code}_ERROR`, `${service} had a problem (${res.status})`);
        console.warn(`[http] ${service} ${where} → ${res.status} (attempt ${attempt}/${attempts})`);
        await res.body?.cancel().catch(() => {});
      } else {
        const text = await res.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            throw new AppError(502, `${code}_ERROR`, `${service} sent an answer that isn't JSON`);
          }
        }
        return { status: res.status, data };
      }
    }

    // Exponential backoff with jitter: 300 ms, 600 ms, … (± 25 %), so retries don't arrive in lockstep.
    if (attempt < attempts) await sleep(retryDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
  }
  throw lastError;
}
