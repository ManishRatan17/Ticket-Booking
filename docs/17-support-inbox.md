# 17 · The support inbox

People can write to the organisers, and admins answer and decide. The first use is the most important one: **"may I buy more than the 4-ticket limit?"** (a family of 6, a school group). Approving it really raises that person's limit for that event. Later, ban appeals will use the same inbox.

```
person ── "Help" → new request (more tickets for event X, +2, "we're a family of 6") ──► OPEN
   ▲                                                                                     │
   └──── messages back and forth ◄──────────────── admin ("Support inbox") ◄─────────────┘
                                                      │
                                    Approve / Decline (more tickets) · Close (anything)
                                                      │
                     approved → this person's limit for THIS event = 4 + 2 = 6
```

## Data (migration [009](../server/migrations/009_support.sql))

| Table | What | Rules |
|---|---|---|
| `support_requests` | one request: `kind` (`more_tickets` / `question`), `event_id`, `extra_tickets` (1–4), `status` (`open` → `approved` / `declined` / `closed`), who decided and when | **one open request per person, kind and event** (a partial unique index, `WHERE status = 'open'`): asking again doesn't put you ahead, you're sent to the first one (`409 REQUEST_EXISTS` with its id) |
| `support_messages` | the conversation: `from_admin`, `body` (1–2,000 characters) | the person never sees *which* admin answered: messages come "from the organisers" |
| `purchase_limit_overrides` | an approved raise: event, user, `extra` (1–4) | primary key (event, user): one raise per person and event; a later approval replaces it |

If an event is ever deleted, its requests (the conversation history) are **kept**, with `event_id` set to NULL. *(Found by a test: the first version required an event in a table rule, which made deleting such an event impossible. The rule now lives in the API, where requests are created.)*

## The raised limit, everywhere it matters

[purchaseLimit.js](../server/src/modules/reservation/purchaseLimit.js): `limit = 4 + extra`, read from PostgreSQL (one primary-key lookup) every time it's needed:

| Where | Before | Now |
|---|---|---|
| `create-hold.lua` (Redis, fast) | `bought + quantity > 4` | `bought + quantity > limit` (passed in as an argument) |
| the payment transaction (PostgreSQL, the truth) | `paid + quantity > 4` | `paid + quantity > limit` |
| `GET /events/:id/holds/mine` → `purchase` | `{ bought, limit: 4 }` | `{ bought, limit }`: the page offers what this person may really buy |

So an approval takes effect **immediately**, and the fast check and the final check always agree.

## Deciding

- `open → decided` happens with `UPDATE … WHERE status = 'open'`: **two admins deciding at the same moment can't both win** (tested: one 200, one 409 `REQUEST_NOT_OPEN`, and the limit matches the decision that won).
- "Approved" and "limit raised" are written **in one transaction**: there's never an approved request without its raise, or the other way round.
- Only `more_tickets` can be approved (`409 NOT_APPROVABLE`); any request can be closed. A decided request takes no more messages (`409 REQUEST_CLOSED`); the person can open a new one.
- Every decision is logged: `[support] admin 3 approved request 12 (more_tickets, user 41)`.

## Protection

| Threat | Defence |
|---|---|
| Reading or writing someone else's request | ownership is part of the SQL (`AND user_id = $2`): **404**, never 403 |
| Flooding the admins | 5 new requests an hour per person, 30 messages an hour; one open request per kind and event; messages ≤ 2,000 characters |
| A normal user using the admin endpoints | they live in the admin router (default deny: `403`) |
| Admin identity leaking to people | the person's view has no admin ids or emails |

## Endpoints

People (signed in): `POST /api/support/requests` · `GET /api/support/requests` · `GET /api/support/requests/:id` · `POST /api/support/requests/:id/messages`.
Admins: `GET /api/admin/support?status=` · `GET /api/admin/support/:id` · `POST /api/admin/support/:id/messages` · `POST /api/admin/support/:id/decision`. Details in [09](09-api-reference.md#support-inbox).

## Pages

| Page | What |
|---|---|
| **Help** (`/support`, [SupportPage](../client/src/pages/SupportPage.jsx)) | "Ask the organisers": more tickets (event, how many more, why) or a question; the list of my requests with their status |
| `/support/:id` ([SupportRequestPage](../client/src/pages/SupportRequestPage.jsx)) | the conversation; "Approved: you can now buy up to 6 tickets for this event" with a link to it |
| **Support inbox** (`/admin/support`, [AdminSupportPage](../client/src/pages/AdminSupportPage.jsx)) | open requests first, oldest first, "needs a reply" when the person spoke last; the conversation; Approve (+N) / Decline / Close with an optional message |
| The event page | at the limit: "You've bought the maximum of 4 … **Ask the organisers for more**" → the Help form, already filled in |

Not yet: emails when an answer arrives (a real mail provider comes in Phase 7). Until then people see answers on the Help page.

*Tested in [support.test.js](../server/test/support.test.js): a request with its first message, no admin details for the person; validation (kind, event, 1–4 extra, message length, unknown event); one open request per kind and event → 409 pointing at the first; someone else's request → 404; normal users → 403 on the admin inbox; a conversation in order, with "needs a reply"; **approved +2 → limit 6 for holds and payments**, only for that person and event; declined → limit 4, no more messages, can't be decided again, may ask again; **two admins deciding at once → exactly one wins**; questions can be closed, not approved; deleting an event keeps the conversation. Mutations: approval without raising the limit → 2 tests fail; the payment check ignoring the raise → the approval test fails.*
