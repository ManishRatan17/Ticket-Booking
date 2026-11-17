// Password hashing with argon2id. Passwords are NEVER stored, logged or returned — only hashes.
import argon2 from 'argon2';

// OWASP-recommended minimum for argon2id: 19 MiB memory, 2 iterations, 1 thread.
// Memory-hard = each guess needs 19 MiB of RAM, which makes GPU cracking very expensive.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // in KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
};

// The same password can be typed as different Unicode byte sequences on different devices
// (e.g. "é" as one character or as "e" + accent). NFKC turns them into one canonical form.
function normalize(password) {
  return password.normalize('NFKC');
}

// Returns e.g. "$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>".
// argon2 generates a fresh random salt for every call, and stores it inside the string.
export function hashPassword(password) {
  return argon2.hash(normalize(password), HASH_OPTIONS);
}

// Reads the algorithm, settings and salt FROM the stored hash, hashes the attempt
// the same way, and compares in constant time.
export async function verifyPassword(storedHash, password) {
  try {
    return await argon2.verify(storedHash, normalize(password));
  } catch {
    return false; // malformed hash: treat as "wrong password", never crash login
  }
}

// True if a stored hash was made with older/weaker settings than HASH_OPTIONS.
// Used at login (Step A3) to silently upgrade old hashes.
export function needsRehash(storedHash) {
  return argon2.needsRehash(storedHash, HASH_OPTIONS);
}
