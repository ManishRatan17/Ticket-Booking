// Sending email, behind a small interface so the delivery method can be swapped:
//   development → printed in the console (no account or setup needed)
//   tests       → captured in memory (setMailTransport), to read the link out of them
//   production  → Resend (resend.com), when RESEND_API_KEY is set: one HTTPS call, no extra package
//
// sendMail() puts the email on the JOB QUEUE (when background jobs are on): the worker delivers it,
// RETRYING with growing pauses if the provider is down, and a crash between "decided to send" and
// "sent" can't lose it. (Before Phase 7 a password-reset email was lost if the server crashed at
// that moment.) Without jobs (the general test suite), it's delivered at once.
//
// A "transport" is any async function ({ to, subject, text }) => void.
import { env } from '../config/env.js';

function consoleTransport({ to, subject, text }) {
  const line = '─'.repeat(64);
  console.log(`\n${line}\n📧  To: ${to}\n    Subject: ${subject}\n\n${text}\n${line}\n`);
}

// Resend's REST API: https://resend.com/docs/api-reference/emails/send-email
async function resendTransport({ to, subject, text }) {
  const res = await fetch(env.mail.resendUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.mail.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.mail.from, to: [to], subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  // An error makes the job fail → BullMQ retries it (and keeps it in the dead-letter queue at the end).
  if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const defaultTransport = () => (env.mail.resendApiKey ? resendTransport : consoleTransport);
let transport = defaultTransport();

export function setMailTransport(fn) {
  transport = fn ?? defaultTransport();
}

// Actually send it (the worker's 'send-email' job calls this).
export async function deliverMail(message) {
  await transport(message);
}

// "Send this email": on the job queue when jobs are on, else right now.
export async function sendMail(message) {
  if (!env.jobs.enabled) return deliverMail(message);
  const { queueEmail } = await import('../jobs/queue.js'); // (loaded lazily: the queue imports a lot)
  await queueEmail(message);
}
