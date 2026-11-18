// Sending email, behind a small interface so the delivery method can be swapped:
//   development → print the email in the server console (no account or setup needed)
//   tests       → capture emails in memory to read the link out of them
//   production  → a real provider (Resend, SES, SMTP…), plugged in at deploy time (Phase 7)
//
// A "transport" is any async function ({ to, subject, text }) => void.

function consoleTransport({ to, subject, text }) {
  const line = '─'.repeat(64);
  console.log(`\n${line}\n📧  To: ${to}\n    Subject: ${subject}\n\n${text}\n${line}\n`);
}

let transport = consoleTransport;

export function setMailTransport(fn) {
  transport = fn ?? consoleTransport;
}

export async function sendMail(message) {
  await transport(message);
}
