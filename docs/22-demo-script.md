# 22 · Demo video script (about 2 minutes)

For a 2-minute screen recording (OBS Studio, or the Windows Game Bar: Win + G). Speak the **"Say"** lines; do the **"Show"** steps. Rehearse once: the timings matter more than the words.

## Before you record

1. `docker compose up -d` and `npm run dev` (the API, the **worker** and the website).
2. `npm run seed:demo` **about 4 minutes before** recording: *Demo: Lucky Draw Concert*'s sale opens 5 minutes after seeding, and its draw 2 minutes after that.
3. Have three windows ready: **A** normal browser (a normal account), **B** a private window (a second normal account), **C** an admin account (`npm run set-role -- admin@… admin`).
4. Open `docs/19-load-testing.md` in a tab for the numbers.

## The script

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | the home page | "Imagine 300 tickets for a huge concert and 10,000 people pressing *buy* at the same second. Most sites either sell a seat twice or crash. I built a ticketing system that does neither, and I measured it." |
| 0:15–0:35 | A and B open *Lucky Draw Concert* → **Join the queue** (the "are you a person?" check passes) → "You're in the lobby with 2 people" | "Before the sale opens, everyone waits in a lobby. When it opens, everyone in the lobby gets a **random** place, so clicking at the exact second, or using a bot, gives no advantage." |
| 0:35–0:50 | the sale opens: positions appear, then "**It's your turn!**" in A | "A worker lets people in at a steady rate. Everyone sees their live position and their chances: good, maybe or unlikely." |
| 0:50–1:05 | A holds 2 tickets → Checkout → pay (Razorpay test card, or the fake **Pay**) → ticket numbers | "Holding a ticket is one atomic step in Redis: check and take together, so two people can never get the same ticket. Payment is confirmed by a signed message from the payment provider, never by the browser." |
| 1:05–1:20 | the lucky draw: B sees "🎉 You won the lucky draw" (or "Not this time") → **Verify the draw in my browser** → ✅ | "Twenty percent of the tickets go to a lucky draw. It's provably fair: the draw's secret seed was published as a fingerprint before the draw, and anyone can check the result in their own browser." |
| 1:20–1:35 | C: **Manage events** (live sold / held / left / revenue) → **Restrictions (1 new)** → "⚠ … was suspended for bot-like activity" | "Admins watch the sale live. Accounts that behave like bots are suspended automatically, and the admin is told who and why. People can appeal." *(To have a strike to show: in a terminal, hammer **Hold** on any event with a test account, or restrict one by hand.)* |
| 1:35–1:55 | `docs/19-load-testing.md`: the results table | "I load-tested it with 10,000 simulated people: exactly 300 tickets sold, zero duplicates, zero failed requests, and through the waiting room a median answer time of 3 milliseconds. The load test also found a database bottleneck, which I fixed, almost doubling throughput." |
| 1:55–2:05 | the GitHub README | "Everything is documented, with 400 automated tests and every design decision written down. Thanks for watching." |

## Tips

- Zoom the browser to 125 % so text is readable in the video.
- If something is slow live, cut it in editing: the numbers come from the load test, not the recording.
- Record in one take per scene, then join them; a perfect single take isn't needed.
