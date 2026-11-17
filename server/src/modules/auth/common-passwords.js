import { readFileSync } from 'node:fs';

// Loaded once at startup into a Set: checking a password is then a single, instant lookup.
const text = readFileSync(new URL('./data/common-passwords.txt', import.meta.url), 'utf8');

const COMMON_PASSWORDS = new Set(
  text
    .split(/\r?\n/) // \r? handles Windows line endings
    .filter((line) => line && !line.startsWith('#')),
);

// Case-insensitive: "BasketBall" is as guessable as "basketball".
export function isCommonPassword(password) {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}
