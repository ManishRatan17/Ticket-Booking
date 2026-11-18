// Cookie helpers for tests. Node's fetch() has no cookie jar, so tests read Set-Cookie
// headers and send Cookie headers by hand — which also lets them play "attacker" by
// sending an old or stolen token on purpose.

// A cookie the response set: { raw, value }, or null if it didn't set one.
// `raw` is the whole header ("access_token=...; Path=/api; HttpOnly; ..."), for checking flags.
export function readSetCookie(res, name) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return raw ? { raw, value: decodeURIComponent(raw.split(';')[0].slice(name.length + 1)) } : null;
}

// { access_token: 'a', refresh_token: undefined } → "access_token=a"  (empty values skipped)
export function cookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

// The flags of a Set-Cookie header, lowercased: ["httponly", "secure", "path=/api", ...]
export function cookieFlags(raw) {
  return raw.split(';').map((part) => part.trim().toLowerCase());
}
