import { bearerTokenMatches, requireApiToken } from '../auth';

describe('API token', () => {
  const token = 'f3a1c9e07b2d4c6aa1e5';

  it('accepts the configured bearer token', () => {
    expect(bearerTokenMatches(`Bearer ${token}`, token)).toBe(true);
    expect(bearerTokenMatches(`bearer ${token}`, token)).toBe(true);
  });

  it('rejects missing, malformed and wrong tokens', () => {
    expect(bearerTokenMatches(undefined, token)).toBe(false);
    expect(bearerTokenMatches(token, token)).toBe(false);
    expect(bearerTokenMatches('Bearer', token)).toBe(false);
    expect(bearerTokenMatches(`Basic ${token}`, token)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${token}x`, token)).toBe(false);
  });

  it('never matches when no token is configured', () => {
    expect(bearerTokenMatches('Bearer anything', '')).toBe(false);
  });

  it('answers 401 without calling the route', () => {
    const res: any = { set: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireApiToken(token)({ get: () => 'Bearer nope' } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets authorized requests through', () => {
    const next = jest.fn();
    requireApiToken(token)({ get: () => `Bearer ${token}` } as any, {} as any, next);
    expect(next).toHaveBeenCalled();
  });
});
