# 08 · Frontend (React)

Everything lives in [client/src/](../client/src/). Styling is deliberately minimal for now (Phase 7).

## Pages and who may see them ([App.jsx](../client/src/App.jsx))

| URL | Page | Access | Backend used |
|---|---|---|---|
| `/` | [HomePage](../client/src/pages/HomePage.jsx) | anyone | `/api/health`, `GET /api/events` (lists events; with none, explains how to create some) |
| `/events` | [EventsPage](../client/src/pages/EventsPage.jsx) | anyone | `GET /api/events` |
| `/events/:id` | [EventPage](../client/src/pages/EventPage.jsx) | anyone (holding needs login) | event, hold, my hold, release; waiting room: join, status, `queue/stream` (SSE) |
| `/login` | [LoginPage](../client/src/pages/LoginPage.jsx) | signed-out only | login, Google |
| `/register` | [RegisterPage](../client/src/pages/RegisterPage.jsx) | signed-out only | register → login |
| `/forgot-password` | [ForgotPasswordPage](../client/src/pages/ForgotPasswordPage.jsx) | signed-out only | forgot-password |
| `/reset-password#token=…` | [ResetPasswordPage](../client/src/pages/ResetPasswordPage.jsx) | anyone (link from email) | reset-password |
| `/checkout/:id` | [CheckoutPage](../client/src/pages/CheckoutPage.jsx) | signed in | `GET /api/orders/:id`, `POST /api/payments/fake/:id`, then polls the order until the webhook has settled it |
| `/orders` | [OrdersPage](../client/src/pages/OrdersPage.jsx) | signed in | `GET /api/orders` (ticket numbers for paid orders, "pay now" for pending ones) |
| `/account` | [AccountPage](../client/src/pages/AccountPage.jsx) | signed in | sessions, delete session, logout-all |
| `/admin/users` | [AdminUsersPage](../client/src/pages/AdminUsersPage.jsx) | admin | list users, change role |
| `/admin/events` | [AdminEventsPage](../client/src/pages/AdminEventsPage.jsx) | admin | create event (optionally with a waiting-room rate), list events |
| `/admin/jobs` | [AdminJobsPage](../client/src/pages/AdminJobsPage.jsx) | admin | `GET /api/admin/jobs` every 5 s, `POST /api/admin/jobs/:id/retry` |
| anything else | NotFoundPage | anyone | — |

The [Layout](../client/src/components/Layout.jsx) wraps every page: nav bar (Events · Log in/Register, or My orders, your email → Account, Log out; admins also see Users, Manage events and Jobs) and the Google sign-in result message.

## How data flows

```
Page  ──► useAuth() / api/events.js / api/admin.js ──► api/client.js api() ──► fetch('/api/…')
 shows    (one function per endpoint)                    JSON in/out, refresh on 401,     cookies go
 ApiError                                                 errors → ApiError               automatically
```

### The API client — [api/client.js](../client/src/api/client.js), the only `fetch()` in the app

1. Sends/receives JSON. **Never touches a token**: both are HttpOnly cookies the browser sends by itself.
2. **401 `AUTH_REQUIRED` or `TOKEN_EXPIRED`** → `POST /api/auth/refresh` once → retry the request once (never loops).
3. **One refresh at a time:** if several requests expire together they share one refresh (`refreshInFlight`). Several parallel refreshes with one cookie would trip the server's "two tabs" protection.
4. **409 `REFRESH_CONFLICT`** (another tab just refreshed) → wait 250 ms and carry on: the new cookies are already arriving in this browser.
5. **401 that means the session is over** (`SESSION_REVOKED`, `SESSION_EXPIRED`, `INVALID_TOKEN`, `REFRESH_TOKEN_REUSED`), or a refresh that fails → tell `AuthProvider` "signed out" (no pointless refresh). A wrong password (`INVALID_CREDENTIALS`) is just an error.
6. Errors become `ApiError { status, code, message, details, retryAfterSeconds }` (`retryAfterSeconds` from the `Retry-After` header on 429).

### Auth state — [auth/AuthProvider.jsx](../client/src/auth/AuthProvider.jsx)

Holds `{ status: 'loading' | 'signed-in' | 'signed-out', user }` and `login`, `register` (= register then login), `logout`, `logoutAll`, `reload`. On page load it calls `/api/auth/me` (the API client refreshes if needed). It listens for "session ended" from the API client. It stores the **user object** (id, email, role) — display data, not a secret.

### Route guards — [auth/guards.jsx](../client/src/auth/guards.jsx)

`RequireAuth` (→ `/login`, remembering where you were), `RequireAdmin` (→ `/`), `GuestOnly` (signed-in users → `/`). **They are convenience, not security**: anyone can bypass the browser; the server answers 401/403 regardless.

## Validation and error messages

- [lib/validation.js](../client/src/lib/validation.js) mirrors the server's rules for **instant feedback** (email format, 10–128 characters, not the email, confirmation matches). The server stays the authority (it alone has the common-password list); its `details` are shown under the right field by `fieldErrors()` in [lib/errorMessages.js](../client/src/lib/errorMessages.js).
- `errorMessage()` turns codes into sentences (e.g. `LAST_ADMIN` → "This is the only admin left…"); `SOLD_OUT` and `RATE_LIMITED` keep the server's message because it contains a number.

## Countdowns that don't trust the user's clock

[lib/serverClock.js](../client/src/lib/serverClock.js) + [hooks/useCountdown.js](../client/src/hooks/useCountdown.js):

```
offset      = serverTime − this device's time when the response arrived
server now  = Date.now() + offset
seconds left = expiresAt − server now
```

A laptop 3 minutes fast or 10 minutes slow still shows 5:00 for a new hold (unit-tested). `useCountdown` keeps only "now" in state (ticks every second) and **computes** the seconds left during render; when it reaches 0 it calls back — the event page then asks the server, which releases the expired hold and says so.

## The event page in detail

1. Loads the event and (if signed in) your hold, in parallel.
2. Not on sale → "On sale in 0:42:10" (reloads when it reaches 0).
3. Signed out → "Log in to hold tickets" (login returns you here).
4. Choose 1–`min(4, available)` → **Hold tickets** → "You're holding N tickets. Hold expires in 4:59" + **Release tickets**.
5. `SOLD_OUT` / `HOLD_EXISTS` → message, then reload the real stock and your real hold.
6. Hold expires → "Your hold expired and the tickets went back on sale."
7. **Waiting room** (events with `admissionPerSecond`, Phase 4): signed out → "Log in to join the queue"; signed in → [WaitingRoom](../client/src/components/WaitingRoom.jsx) ("Join the queue", then "You're #N of M in line", kept live by [useQueueStatus](../client/src/hooks/useQueueStatus.js): Server-Sent Events, falling back to polling every 2 s); admitted → "It's your turn! Choose your tickets within 9:58" + the hold form. Details: [14-waiting-room.md](14-waiting-room.md#the-queue-screen-step-4c).
8. **Protection** (Phase 5): the quantity list offers only what you may still buy (`purchase: { bought, limit }`), "You've bought the maximum of 4 tickets" at the limit; joining the queue shows the "are you a person?" widget ([TurnstileWidget](../client/src/components/TurnstileWidget.jsx), [useHumanCheck](../client/src/hooks/useHumanCheck.js)), as does the register page (plus a hidden honeypot field). Details: [15-protection.md](15-protection.md).
9. **Lucky draw**: [LuckyDrawPanel](../client/src/components/LuckyDrawPanel.jsx) shows the draw (entered, odds, "You won!", "Not this time", closed) and, after the draw, the seed, your draw number and a "Verify the draw in my browser" button ([lib/verifyDraw.js](../client/src/lib/verifyDraw.js), Web Crypto). A winner gets the hold form for lucky-draw tickets (max per winner). My orders marks lucky-draw orders. Details: [16-lucky-draw.md](16-lucky-draw.md).

## Other details

- **Google result:** the callback redirects to `/?login=…`; `Layout` reads it **once** (when it's created after the full page load), shows a message, and removes it from the address bar.
- **Reset link:** the page reads `#token=` once and removes it from the address bar (and so from history).
- **React StrictMode** runs effects twice in development; data-loading effects use an `active` flag so a discarded run can't update state, and the API client's shared refresh prevents double refreshes.
- **Lint rules learned:** never call `setState` synchronously in an effect body; set state in async callbacks, or derive values during render.
- **Tests:** [api/client.test.js](../client/src/api/client.test.js) (fake `fetch`: refresh, single-flight, 409, session-over, errors), [lib/format.test.js](../client/src/lib/format.test.js), [lib/serverClock.test.js](../client/src/lib/serverClock.test.js).
