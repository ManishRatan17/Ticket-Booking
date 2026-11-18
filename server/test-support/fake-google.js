// A tiny FAKE "Google" (OpenID provider) for automated tests, so they never touch the real one.
// It does what Google does in the flow: hands out one-time codes, checks PKCE at the token
// endpoint, signs ID tokens with its own RSA private key and publishes the public key (JWKS).
//
// Lives outside test/ on purpose: Node's test runner runs every .js file inside test/.
import express from 'express';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export async function startFakeGoogle({ clientId, clientSecret }) {
  const keys = await generateKeyPair('RS256'); // "Google's" real key pair
  const attackerKeys = await generateKeyPair('RS256'); // used to forge tokens in tests
  const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'fake-key-1', alg: 'RS256', use: 'sig' };

  const codes = new Map(); // one-time code → what to do when it's exchanged

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // JWKS: the PUBLIC key anyone can use to check our signatures.
  app.get('/certs', (req, res) => res.json({ keys: [publicJwk] }));

  // Token endpoint: checks the code, the client credentials and the PKCE verifier.
  app.post('/token', async (req, res) => {
    const { grant_type, code, client_id, client_secret, code_verifier, redirect_uri } = req.body;
    const entry = codes.get(code);
    codes.delete(code); // codes are single-use, like Google's
    const challenge = code_verifier && createHash('sha256').update(code_verifier).digest('base64url');

    const ok =
      grant_type === 'authorization_code' &&
      entry &&
      client_id === clientId &&
      client_secret === clientSecret &&
      redirect_uri === entry.redirectUri &&
      challenge === entry.codeChallenge;
    if (!ok) return res.status(400).json({ error: 'invalid_grant' });

    res.json({ id_token: await entry.makeIdToken(), access_token: 'fake', token_type: 'Bearer', expires_in: 3600 });
  });

  const server = app.listen(0);
  await once(server, 'listening');
  const url = `http://localhost:${server.address().port}`;

  function signIdToken(claims, { forge = false } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: url, aud: clientId, iat: now, exp: now + 3600, email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key-1' })
      .sign(forge ? attackerKeys.privateKey : keys.privateKey);
  }

  // Plays the part of the USER on Google's page: reads the URL our server redirected to,
  // "signs in", and returns what Google would append to our callback: { code, state }.
  //   claims                 → override ID-token claims (sub, email, nonce, aud, exp…)
  //   forge                  → sign with a key that is NOT Google's
  //   codeChallengeOverride  → remember a different PKCE challenge (simulates a stolen code)
  function authorize(authUrl, { claims = {}, forge = false, codeChallengeOverride } = {}) {
    const params = new URL(authUrl).searchParams;
    if (params.get('client_id') !== clientId) throw new Error('fake google: wrong client_id');
    if (params.get('response_type') !== 'code') throw new Error('fake google: expected response_type=code');
    if (params.get('code_challenge_method') !== 'S256') throw new Error('fake google: expected PKCE S256');

    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      redirectUri: params.get('redirect_uri'),
      codeChallenge: codeChallengeOverride ?? params.get('code_challenge'),
      makeIdToken: () => signIdToken({ nonce: params.get('nonce'), ...claims }, { forge }),
    });
    return { code, state: params.get('state') };
  }

  return { url, authorize, close: () => server.close() };
}
