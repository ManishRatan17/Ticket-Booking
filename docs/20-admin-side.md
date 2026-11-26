# 20 · The admin side

Admins **run** the sale; they don't take part in it. This page covers what an admin sees and can do, and the rules behind it.

```
Admin nav:  Manage events · Support inbox · Refunds · Restrictions (2 new) · Users · System · Audit log
Customer:   Events · My orders · Help
```

## Admins don't buy, and don't ask for help

| Rule | How it's enforced | Why |
|---|---|---|
| Admins can't hold, join a queue, order or pay | [customersOnly](../server/src/middleware/customersOnly.js) right after `authenticate` on those four routes → **`403 ADMINS_CANNOT_BUY`** | the people who set the rules shouldn't compete with fans for tickets, or ever be suspected of it. An admin who wants tickets uses a normal account |
| Admins don't send support requests | `notForAdmins` on creating a request and on writing in one → **`403 ADMINS_USE_INBOX`** | admins *answer* requests (Support inbox); there's no one above them to ask |
| The page doesn't offer it | the event page shows "You're signed in as an admin. Admin accounts can't buy tickets…" with a link to the event's live numbers; "My orders" and "Help" aren't in an admin's nav; `/support` sends admins to the inbox | hiding buttons is only a convenience: the server rule is what protects it (tested by removing it: the test fails) |

## Manage events

`/admin/events`: **every event with live numbers**, refreshed every 5 seconds ([admin.events.js](../server/src/modules/admin/admin.events.js)):

| Column | Where it comes from |
|---|---|
| Status: Upcoming · On sale · All held · Sold out · Cancelled | the sale time; sold = total → sold out; nothing left but not all paid → all held; cancelled by an admin |
| Sold | PostgreSQL `tickets_sold` (paid tickets: the record) |
| Left | Redis: the normal stock + what the lucky draw still has |
| Held | total − sold − left: in someone's hold right now |
| Revenue, paid orders | PostgreSQL: the paid orders |
| Waiting room: in line, rate | Redis: the queue's size |
| Lucky draw: left, entered | Redis: the draw's stock and its entrants |

The "Create an event" form is folded below the table.

**One event** (`/admin/events/:id`): the same numbers as cards, a link to the shop page, and **editing**:

| Field | Can change |
|---|---|
| Name | any time |
| Price, sale time, waiting-room rate, lobby window | **only before the sale opens** (`409 SALE_STARTED`): changing the price after people paid, or the time after people queued, would be unfair |
| Removing the waiting room of an event with a lucky draw | never (`409 LOTTERY_NEEDS_ROOM`: the draw's entrants are the waiting room) |
| Number of tickets, lucky-draw settings | never: the stock and the draw's committed seed are built on them |

An edit clears this server's 1-second copy of the event ([19](19-load-testing.md)), so the shop shows it at once.

**Cancelling** (bottom of the event's page): a reason (shown to customers), then "Cancel event and refund everyone", confirmed once more by the browser. The sale and the waiting room stop at once, unpaid orders end, every paid order is refunded and its buyer emailed. It can't be undone, and a cancelled event can't be edited. The page then shows "Cancelled" with the date and reason; the refunds appear on the Refunds page. How it stays safe while people are paying: [12](12-orders-and-payments.md#cancelling-an-event).

## System (was "Jobs")

`/admin/system` is the control room for work that happens **without anyone clicking** ([13](13-background-jobs.md)):

- releasing holds nobody paid for within 5 minutes
- a safety sweep every 60 seconds
- letting people in from waiting rooms every second
- running lucky draws every 5 seconds
- processing refunds, sending emails
- daily housekeeping (old sessions, expired reset links, old webhook records)

A **green / red light** says whether the background worker is running (red: "expired holds are NOT released, nobody is let in, lucky draws don't happen"). Failed jobs are listed with **Retry**.

## Bot notifications

When the system strikes an account automatically ([18](18-bot-strikes.md)), the admins should know, and know **who**:

- The nav shows **Restrictions (2 new)** (asked every 30 seconds).
- The Restrictions page opens with a red box: *"⚠ **ann@example.com** was suspended for bot-like activity (3 minutes ago): score 20 in 10 min: 20 × actions refused by rate limits"*, and a **Mark as seen** button.
- Restrictions an admin made **by hand** aren't "new" (the admin already knows).

Accounts have no names, only an email, so the email identifies the person. Migration [011](../server/migrations/011_admin_notifications.sql) adds `acknowledged_at` / `acknowledged_by` to `account_restrictions`. Endpoints: `GET /api/admin/notifications` → `{ count, latest }`, `POST /api/admin/restrictions/acknowledge`.

Email notifications to admins need a real email provider: Phase 7.

*Tested in [admin-console.test.js](../server/test/admin-console.test.js): admins → 403 on hold, join, order and pay (normal people unaffected); admins → 403 on sending support requests; the live numbers (3 sold, 2 held, 5 left, ₹1,500 revenue, 1 paid order) and every status; editing before the sale (price, time, waiting room; the shop sees it at once); after the sale only the name (`SALE_STARTED`); a lucky draw keeps its waiting room; validation; admins only; a new automatic strike shows up with the person's email and evidence, a hand-made one doesn't, "mark as seen" clears it. Mutation: the admin rule removed from holds → the test fails.*

## Audit log

`/admin/audit`: **every change an admin made**, newest first, filterable by action: who (their email), what, to which user / event / request / refund, the details (e.g. the new price), when.

```
admin request (POST / PATCH)  ──► the admin route does its work ──► response sent
                                                              │
     auditAdminActions (on the whole /api/admin router)  ◄────┘ 'finish': status < 400?
                                                              │ yes
                                     INSERT admin_audit_log (admin, action, target, details)
```

| Piece | What it does |
|---|---|
| [lib/audit.js](../server/src/lib/audit.js) `auditAdminActions` | mounted once with the admin guard: `app.use('/api/admin', authenticate, requireRole('admin'), auditAdminActions, adminRouter)`. Skips GET (reading changes nothing); records a request only if it **succeeded**. Like "default deny", it's **"default audited"**: a new admin route is recorded without anyone remembering to |
| Action names | a table maps routes to readable names: `PATCH /users/:id/role` → `role.change`, `PATCH /events/:id` → `event.update`, `POST /refunds/:id/retry` → `refund.retry`, … A route not in the table is still recorded, under its method and path |
| Target | the `:id` in the URL; for creating an event, the new event's id (the route passes it on) |
| Details | the validated request body (long texts such as support replies shortened to 300 characters) |
| The command line | `npm run set-role` writes an entry as `command line (set-role)`: making an admin is the most powerful change there is |
| **Append-only** | migration [014](../server/migrations/014_audit_log.sql) puts a trigger on the table that **refuses every UPDATE and DELETE**, so even code or a person with the app's database access can't rewrite history |
| Survives the admin | `admin_email` is stored with the entry, and `admin_id` has no foreign key: deleting an account later doesn't delete what it did |

Housekeeping never trims it (see [13](13-background-jobs.md)). Honest limit: the entry is written just after the response; a crash in that instant could lose one entry (it never records something that didn't happen).

*Tested in [audit.test.js](../server/test/audit.test.js): role change, event create + edit, failed actions and reads not recorded, set-role recorded, the database refusing UPDATE/DELETE, reading and filtering, normal users → 403. Mutation: the middleware removed → 3 tests fail.*
