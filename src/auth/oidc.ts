import * as client from 'openid-client';
import { config } from '../config.js';

// Wrapper around openid-client v6 for the Authorization Code + PKCE flow.
// Discovery runs once, lazily, and is cached for the process lifetime.

let configPromise: Promise<client.Configuration> | null = null;

export function isAuthConfigured(): boolean {
  return Boolean(
    config.auth.enabled &&
      config.auth.issuer &&
      config.auth.clientId &&
      config.auth.clientSecret &&
      config.auth.sessionSecret,
  );
}

async function getOidcConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    configPromise = (async () => {
      const cfg = await client.discovery(
        new URL(config.auth.issuer),
        config.auth.clientId,
        config.auth.clientSecret,
      );
      // local dev only, against a plain-HTTP issuer
      if (config.auth.allowInsecure) client.allowInsecureRequests(cfg);
      return cfg;
    })();
  }
  return configPromise;
}

export interface PendingLogin {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Build the authorization URL plus the PKCE/state to stash in a cookie. */
export async function beginLogin(redirectUri: string): Promise<PendingLogin> {
  const cfg = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri,
    scope: config.auth.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  return { authorizationUrl: url.href, state, nonce, codeVerifier };
}

export interface OidcIdentity {
  sub: string;
  email: string | null;
  name: string | null;
}

export interface CompletedLogin {
  identity: OidcIdentity;
  idToken: string | null;
}

/** Exchange the auth code for tokens and validate the ID token. */
export async function completeLogin(
  currentUrl: URL,
  checks: { state: string; nonce: string; codeVerifier: string },
): Promise<CompletedLogin> {
  const cfg = await getOidcConfig();
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    pkceCodeVerifier: checks.codeVerifier,
  });

  const claims = tokens.claims();
  if (!claims?.sub) throw new Error('OIDC: ID token missing subject');

  // prefer ID-token claims, fall back to UserInfo when email/name are missing
  let email = (claims.email as string | undefined) ?? null;
  let name = (claims.name as string | undefined) ?? null;
  if ((!email || !name) && tokens.access_token) {
    try {
      const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
      email = email ?? (info.email as string | undefined) ?? null;
      name = name ?? (info.name as string | undefined) ?? null;
    } catch {
      // UserInfo is optional
    }
  }

  const identity: OidcIdentity = { sub: claims.sub, email, name };
  if (!isUserAllowed(identity)) {
    throw new UserNotAllowedError(email ?? identity.sub);
  }
  return { identity, idToken: tokens.id_token ?? null };
}

export class UserNotAllowedError extends Error {
  constructor(who: string) {
    super(`User not permitted: ${who}`);
  }
}

// applies the optional email / domain allow-lists
export function isUserAllowed(identity: { email: string | null }): boolean {
  const { allowedEmails, allowedDomains } = config.auth;
  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true;
  const email = identity.email?.toLowerCase();
  if (!email) return false;
  if (allowedEmails.includes(email)) return true;
  const domain = email.split('@')[1];
  return Boolean(domain && allowedDomains.includes(domain));
}

/** RP-initiated logout URL, if the provider supports it. */
export async function buildLogoutUrl(
  idToken: string | null,
  postLogoutRedirectUri: string,
): Promise<string | null> {
  const cfg = await getOidcConfig();
  try {
    const params: Record<string, string> = {
      post_logout_redirect_uri: postLogoutRedirectUri,
    };
    if (idToken) params.id_token_hint = idToken;
    return client.buildEndSessionUrl(cfg, params).href;
  } catch {
    // no end_session_endpoint, so local logout only
    return null;
  }
}
