// "What are my chances of getting a ticket?" — a rough, honest estimate shown as a LEVEL.
//
// Why a level and not "73 %": the inputs are guesses. People buy 1–4 tickets, some never buy,
// some let their hold expire. An exact-looking percentage would be wrong most of the time;
// "good chance / maybe / unlikely" is as precise as the data really is.
//
//   buyersLeft ≈ ticketsLeft ÷ ASSUMED_TICKETS_PER_BUYER          (1,000 tickets → ~500 buyers)
//
//   in line (after the sale opened): compare the people AHEAD of you with buyersLeft
//       ahead < 0.7 × buyersLeft  → good        (#340 of 500 buyers)
//       ahead < 1.3 × buyersLeft  → maybe       (#600: right around where tickets run out)
//       otherwise                 → unlikely    (#1,500)
//   in the lobby (before the sale): everyone has the SAME chance (the fair draw), so compare
//   buyersLeft with the lobby's size: share = buyersLeft ÷ people in the lobby
//       share ≥ 0.8 → good · share ≥ 0.3 → maybe · otherwise → unlikely
//
// And two answers that are not estimates (step 4g), for everyone, whatever their status:
//   sold_out   every ticket is PAID for (PostgreSQL: tickets_sold = total): nothing can come back
//   all_held   none left right now, but some are only HELD: unpaid holds expire and return to sale
//
// Known optimism: people already admitted but not yet holding tickets will take some too.
// The level is recomputed every second as tickets are held and sold, so it corrects itself.
export const ASSUMED_TICKETS_PER_BUYER = 2;

export function estimateChance({ status, position, total, ticketsLeft, soldOutForGood = false }) {
  if (soldOutForGood) return { chance: 'sold_out', ticketsLeft: 0, buyersLeft: 0 };
  const left = Math.max(0, ticketsLeft ?? 0);
  const buyersLeft = Math.ceil(left / ASSUMED_TICKETS_PER_BUYER);
  if (left === 0) return { chance: 'all_held', ticketsLeft: 0, buyersLeft: 0 };

  let chance = null; // not in line, or already admitted: no estimate needed
  if (status === 'waiting') {
    const ahead = position - 1;
    chance = ahead < 0.7 * buyersLeft ? 'good' : ahead < 1.3 * buyersLeft ? 'maybe' : 'unlikely';
  } else if (status === 'lobby') {
    const share = total > 0 ? buyersLeft / total : 1;
    chance = share >= 0.8 ? 'good' : share >= 0.3 ? 'maybe' : 'unlikely';
  }
  return { chance, ticketsLeft: left, buyersLeft };
}
