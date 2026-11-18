// CSRF guard — the second line of defence (SameSite=Strict cookies are the first).
//
// The attack: while you're logged in, evil.com makes YOUR browser send a request to our API.
// The browser attaches our cookies automatically, so the API would think it was you.
//
// Defence: for every request that CHANGES something (anything but GET/HEAD/OPTIONS),
// reject it if the browser tells us it came from another site. Browsers set these headers
// themselves; a web page cannot fake them:
//   Sec-Fetch-Site  same-origin | same-site | cross-site | none   (modern browsers)
//   Origin          the site that started the request             (older browsers too)
//
// Requests with neither header don't come from a browser (curl, Postman, server-to-server).
// CSRF is a BROWSER attack, and those clients only send cookies they were given on purpose.
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']); // must never change anything

export function rejectCrossSiteRequests(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite) {
    // "none" = the user did it directly (typed URL, bookmark). "same-site" (another
    // subdomain) is NOT trusted: a different subdomain may be run by someone else.
    if (fetchSite === 'same-origin' || fetchSite === 'none') return next();
    throw forbidden();
  }

  const origin = req.get('origin');
  if (origin) {
    const allowed = new Set([new URL(env.clientUrl).origin, `${req.protocol}://${req.get('host')}`]);
    if (allowed.has(origin)) return next();
    throw forbidden(); // includes Origin: null (sandboxed iframes, some redirects)
  }

  next(); // not a browser
}

function forbidden() {
  return new AppError(403, 'CSRF_REJECTED', 'Cross-site request blocked');
}
