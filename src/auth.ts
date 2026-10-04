import { createHash, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';

/**
 * True when an `Authorization: Bearer <token>` header carries [expected]. Both values are hashed
 * first so the comparison takes the same time whatever their length.
 */
export function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  if (!match || !expected) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(expected));
}

/** Rejects requests that don't carry the shared API token. */
export function requireApiToken(expected: string): RequestHandler {
  return (req, res, next) => {
    if (bearerTokenMatches(req.get('authorization'), expected)) return next();
    res
      .set('WWW-Authenticate', 'Bearer')
      .status(401)
      .json({ error: "Access denied: the app's API token doesn't match the server's API_TOKEN." });
  };
}
