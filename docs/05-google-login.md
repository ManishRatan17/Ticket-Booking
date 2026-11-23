# 05 · "Continue with Google" (OpenID Connect)

Code: [google.js](../server/src/modules/auth/google.js), [oauth-transactions.js](../server/src/modules/auth/oauth-transactions.js), [identities.repository.js](../server/src/modules/auth/identities.repository.js), `loginWithGoogle` in [auth.service.js](../server/src/modules/auth/auth.service.js), `googleStart` / `googleCallback` in [auth.controller.js](../server/src/modules/auth/auth.controller.js). Migration [003](../server/migrations/003_google_login.sql).

## The idea

The user proves who they are **to Google, on Google's page**. Google hands our server a **signed statement** (an *ID token*): "this is account #1097…, email ann@gmail.com, verified". **Our app never sees the Google password.** After that, Google is out of the picture: the user gets an ordinary session from our own system ([04](04-authentication.md)).

| | OAuth 2.0 | OpenID Connect (what we use) |
|---|---|---|
| Answers | "may this app use my data?" (authorization) | "who is this person?" (authentication) |
| Gives | an access token for Google's APIs | an **ID token** (a JWT about the user) |
| Our scopes | — | `openid email profile` only |

## The flow (Authorization Code flow + PKCE)

```
Browser                         Our server                                   Google
  │ ① click "Continue with Google" (a link, not fetch)
  │── GET /api/auth/google ───────►│ googleStartPerIp (20/min)
  │                                │ ② random state, nonce, code_verifier
  │                                │    Redis oauth:tx:<hash> (10 min) + cookie oauth_tx (SameSite=Lax)
  │◄── 302 to accounts.google.com ─│    ?client_id&redirect_uri&response_type=code&scope=openid email profile
  │                                │     &state&nonce&code_challenge=SHA256(verifier)&code_challenge_method=S256
  │────────────────────────────────────────────────────────────────────────────►│ ③ user signs in, consents
  │◄── 302 back: /api/auth/google/callback?code=…&state=… ─────────────────────│
  │── GET callback (+ oauth_tx cookie) ─►│ ④ GETDEL the attempt (single use) · state matches?
  │                                │ ⑤ server → Google (browser never sees it):
  │                                │──── POST oauth2.googleapis.com/token ──────►│ code + client_secret + code_verifier
  │                                │◄─── { id_token } ────────────────────────────│
  │                                │ ⑥ verify the ID token (below)
  │                                │ ⑦ find / create / link OUR user (one transaction)
  │                                │ ⑧ startSession() — the same as a password login
  │◄── 302 /?login=google + access_token & refresh_token cookies ──│
  │ ⑨ React loads, calls /api/auth/me → signed in
```

**Front channel vs back channel:** steps ①–④ go through the browser (visible to the user and to attackers); step ⑤ is server-to-server. That's why the valuable ID token comes through the back channel, and why the `client_secret` is safe there. Tokens are **never** put in a redirect URL.

## The three random values

| Value | Stops | How |
|---|---|---|
| **state** | **Login CSRF** — an attacker making your browser finish *their* Google sign-in, so you end up in the attacker's account | Random, tied to *this browser* through the `oauth_tx` cookie; must match on return. An attacker's callback link fails with no cookie (`OAUTH_TX_INVALID`) or with the victim's own cookie (`OAUTH_STATE_MISMATCH`) — both tested |
| **PKCE** (`code_verifier` / `code_challenge`) | A stolen `code` being exchanged by someone else | Google only sees `SHA256(verifier)` at the start; the exchange must present the original verifier, which never travelled through the browser |
| **nonce** | An ID token from another (older, stolen) sign-in being replayed | Google copies it into the ID token; we check it matches this attempt |

**Single use:** the attempt is read with `GETDEL` (read and delete in one atomic command), so a replayed callback finds nothing. **SameSite=Lax** on `oauth_tx` is required: the callback is a navigation coming *from* Google, and a `Strict` cookie would not be sent — every sign-in would fail.

## Verifying the ID token (every check is required)

| Check | Why |
|---|---|
| Signature with **Google's public keys** (JWKS from `googleapis.com/oauth2/v3/certs`, cached and refreshed by `jose`) | Proves Google made it. **RS256**: Google signs with its private key; anyone verifies with the public key — unlike our own tokens (HS256, one shared secret) |
| `alg` = RS256 only | `alg: none` / algorithm-swap attacks |
| `iss` = `https://accounts.google.com` (or `accounts.google.com`) | Issued by Google |
| **`aud` = our client id** | Made for **us** — otherwise a token Google issued to another app could log in here (mutation-tested) |
| `exp` | Not expired |
| `nonce` | This attempt (mutation-tested) |
| `email_verified === true` | Google confirms the person owns the email |

Users are identified by Google's **`sub`** (permanent), not by email (which can change).

## Account linking: four cases (one transaction, with retry)

| Situation | What happens |
|---|---|
| 1. This Google account (`sub`) is already linked | sign in that user |
| 2. New `sub`, unknown email | create a user with **no password**, `email_verified_at = now` |
| 3. Email belongs to an account whose email is **verified** | link to it |
| 4. Email belongs to a password account whose email was **never verified** | **"verified email wins":** link, **remove the password**, **revoke all its sessions** ('account_linked') |

Case 4 defeats **account pre-hijacking**: an attacker registers *your* email with their password before you ever visit; when you later use Google, silent linking would leave the attacker with a working password. Tested end to end: the squatter's password stops working and their session dies.

Concurrency: the existing user row is locked (`FOR UPDATE`); if two sign-ins for the same new email race, one `INSERT` hits a unique constraint and the whole decision is retried once. If the email is already linked to a **different** Google account → `409 GOOGLE_ACCOUNT_CONFLICT`.

## Errors

The callback is a page navigation, so every outcome **redirects** back to the app instead of returning JSON: `/?login=google`, `/?login=cancelled`, or `/?login=failed&reason=<CODE>` (`OAUTH_TX_INVALID`, `OAUTH_STATE_MISMATCH`, `OAUTH_CODE_MISSING`, `GOOGLE_EXCHANGE_FAILED`, `GOOGLE_TOKEN_INVALID`, `GOOGLE_EMAIL_UNVERIFIED`, `GOOGLE_ACCOUNT_CONFLICT`, `GOOGLE_UNAVAILABLE`, `GOOGLE_NOT_CONFIGURED`). The frontend's `Layout` reads `?login=` once, shows a message, and cleans the address bar.

Without `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GET /api/auth/google` answers `503 GOOGLE_NOT_CONFIGURED` and nothing crashes.

## Setup (Google Cloud Console)

1. Create a project → OAuth consent screen: External, add yourself as a test user.
2. Create credentials → OAuth client ID → **Web application** → authorized redirect URI **exactly** `http://localhost:5173/api/auth/google/callback`.
3. Put the client id and secret in `server/.env` (never in git), restart `npm run dev`.

## How it's tested without Google

[test-support/fake-google.js](../server/test-support/fake-google.js) is a tiny fake OpenID provider: its own RSA key pair, a JWKS endpoint, one-time codes, PKCE checking at its token endpoint, signed ID tokens. The tests point the Google URLs at it (settings are read when the app is first imported, so tests set them and then `await import()` the app). This makes it possible to test forged signatures, tokens for another app, wrong nonce, expired tokens and stolen codes — none of which can be produced with the real Google.
