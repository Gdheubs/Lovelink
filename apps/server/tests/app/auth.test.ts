import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import { extractBearerToken } from '../../src/app/auth/AuthenticateRequest.js';
import { LIMITS } from '../../src/domain/ports/RateLimiter.js';
import type { DomainError } from '../../src/domain/errors.js';

/**
 * Auth flow, end to end, against the in-memory fakes.
 *
 * These are the tests that would otherwise need a database, a Redis, and an SMS
 * provider. Because every port has a fake, they run in milliseconds — which is
 * what makes it reasonable to cover the boring-but-critical cases: enumeration,
 * replay, rotation, the 18+ boundary, and what a banned user can still do.
 */
describe('auth', () => {
  let ports: MemoryPorts;
  let useCases: UseCases;

  const EMAIL = 'priya@example.com';
  const IP = '203.0.113.5';
  const ADULT_DOB = '1995-06-15';

  beforeEach(() => {
    ports = createMemoryPorts();
    useCases = createUseCases(ports, { echoLoginCode: true });
  });

  /** Complete a full signup and return the result. */
  const register = async (identifier = EMAIL, dob = ADULT_DOB, displayName = 'Priya') => {
    const requested = await useCases.requestLoginCode.execute({ identifier, ip: IP });
    return useCases.verifyLoginCode.execute({
      identifier,
      code: requested.devCode!,
      ip: IP,
      displayName,
      dob,
    });
  };

  // -------------------------------------------------------------------------
  describe('requesting a code', () => {
    it('issues a code and reports the identifier kind', async () => {
      const result = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      expect(result.sent).toBe(true);
      expect(result.identifierKind).toBe('email');
      expect(result.devCode).toMatch(/^\d{6}$/);
    });

    it('detects a phone number and normalizes it', async () => {
      const result = await useCases.requestLoginCode.execute({
        identifier: '+44 7700 900000',
        ip: IP,
      });
      expect(result.identifierKind).toBe('phone');
      // The challenge is keyed by the CANONICAL form, so the spaced version and
      // the compact version are the same identifier.
      expect(await ports.challenges.peek('+447700900000')).not.toBeNull();
    });

    it('DOES NOT reveal whether the account exists', async () => {
      // The enumeration defence. Both responses must be identical in shape.
      const beforeSignup = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      await register();
      const afterSignup = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });

      expect(Object.keys(beforeSignup).sort()).toEqual(Object.keys(afterSignup).sort());
      expect(beforeSignup.sent).toBe(afterSignup.sent);
      expect(beforeSignup.identifierKind).toBe(afterSignup.identifierKind);
    });

    it('rate limits per identifier, to stop SMS bombing a victim', async () => {
      for (let i = 0; i < LIMITS.authRequest.limit; i += 1) {
        await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: `10.0.0.${i}` });
      }
      // Different IP, same victim: still refused.
      await expect(
        useCases.requestLoginCode.execute({ identifier: EMAIL, ip: '10.0.0.99' }),
      ).rejects.toThrow(/too many/i);
    });

    it('rate limits per IP, to cap one actor spreading the cost', async () => {
      for (let i = 0; i < LIMITS.authRequestPerIp.limit; i += 1) {
        await useCases.requestLoginCode.execute({ identifier: `user${i}@example.com`, ip: IP });
      }
      await expect(
        useCases.requestLoginCode.execute({ identifier: 'fresh@example.com', ip: IP }),
      ).rejects.toThrow(/this network/i);
    });

    it('is FAR more generous per IP than per identifier', async () => {
      // IP addresses are shared by offices, campuses and mobile carriers. A
      // per-IP limit as tight as the per-identifier one would lock out everyone
      // behind a single NAT — a self-inflicted outage that looks like a working
      // rate limiter.
      expect(LIMITS.authRequestPerIp.limit).toBeGreaterThan(LIMITS.authRequest.limit * 5);
      expect(LIMITS.authVerifyPerIp.limit).toBeGreaterThan(LIMITS.authVerify.limit * 5);
    });

    it('lets a crowd behind one IP all sign up', async () => {
      for (let i = 0; i < 10; i += 1) {
        await expect(
          useCases.requestLoginCode.execute({ identifier: `colleague${i}@example.com`, ip: IP }),
        ).resolves.toBeTruthy();
      }
    });

    it('never returns a code when echo is off', async () => {
      const production = createUseCases(ports, { echoLoginCode: false });
      const result = await production.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      expect(result.devCode).toBeNull();
    });

    it('rejects a malformed identifier', async () => {
      await expect(
        useCases.requestLoginCode.execute({ identifier: 'not-an-address', ip: IP }),
      ).rejects.toThrow(/country code/i);
      await expect(
        useCases.requestLoginCode.execute({ identifier: 'broken@', ip: IP }),
      ).rejects.toThrow(/valid email/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('registration', () => {
    it('creates an account and returns tokens', async () => {
      const result = await register();

      expect(result.isNewAccount).toBe(true);
      expect(result.profile.displayName).toBe('Priya');
      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();
    });

    it('asks for a name and date of birth when the identifier is new', async () => {
      const requested = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });

      try {
        await useCases.verifyLoginCode.execute({
          identifier: EMAIL,
          code: requested.devCode!,
          ip: IP,
        });
        expect.unreachable('should have required registration details');
      } catch (error) {
        expect((error as DomainError).code).toBe('VALIDATION_FAILED');
        expect((error as DomainError).details.registrationRequired).toBe(true);
      }
    });

    it('ENFORCES the 18+ gate server-side', async () => {
      // Seventeen years and 364 days old relative to the fake clock.
      const clockNow = ports.clock.now();
      const almost18 = new Date(
        Date.UTC(clockNow.getUTCFullYear() - 18, clockNow.getUTCMonth(), clockNow.getUTCDate() + 1),
      );
      const dob = almost18.toISOString().slice(0, 10);

      try {
        await register('teen@example.com', dob, 'Teen');
        expect.unreachable('should have been refused');
      } catch (error) {
        expect((error as DomainError).code).toBe('UNDERAGE');
      }

      // And no account was created.
      expect(await ports.users.findByIdentifier('teen@example.com')).toBeNull();
    });

    it('accepts someone on their eighteenth birthday', async () => {
      const clockNow = ports.clock.now();
      const exactly18 = new Date(
        Date.UTC(clockNow.getUTCFullYear() - 18, clockNow.getUTCMonth(), clockNow.getUTCDate()),
      );
      const result = await register('newadult@example.com', exactly18.toISOString().slice(0, 10));
      expect(result.isNewAccount).toBe(true);
    });

    it('opens the trust ledger so standing is explainable from event one', async () => {
      const result = await register();
      const profile = await useCases.getMyProfile.execute(
        (await ports.users.findById(result.profile.id))!,
      );
      expect(profile.trustHistory).toHaveLength(1);
      expect(profile.trustHistory[0]?.reason).toBe('account_created');
    });

    it('gives the avatar seed a random value, not one derived from the identifier', async () => {
      // An avatar is public; deriving it from a phone number would be a public
      // commitment to that number.
      const a = await register('a@example.com');
      const b = await register('b@example.com');
      expect(a.profile.avatarSeed).not.toBe(b.profile.avatarSeed);
      expect(a.profile.avatarSeed).not.toContain('a@example.com');
    });

    it('rejects a second account on the same identifier', async () => {
      await register();
      // A repeat verify is a LOGIN, not a duplicate account.
      const second = await register();
      expect(second.isNewAccount).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('the login code itself', () => {
    it('cannot be replayed', async () => {
      const requested = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      const code = requested.devCode!;

      await useCases.verifyLoginCode.execute({
        identifier: EMAIL,
        code,
        ip: IP,
        displayName: 'Priya',
        dob: ADULT_DOB,
      });

      // Single-use, even for the legitimate user.
      await expect(
        useCases.verifyLoginCode.execute({ identifier: EMAIL, code, ip: IP }),
      ).rejects.toThrow(/expired/i);
    });

    it('expires', async () => {
      const requested = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      ports.clock.advanceSeconds(601);

      await expect(
        useCases.verifyLoginCode.execute({
          identifier: EMAIL,
          code: requested.devCode!,
          ip: IP,
          displayName: 'Priya',
          dob: ADULT_DOB,
        }),
      ).rejects.toThrow(/expired/i);
    });

    it('rejects a wrong code without saying why in a useful way', async () => {
      await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      await expect(
        useCases.verifyLoginCode.execute({ identifier: EMAIL, code: '000000', ip: IP }),
      ).rejects.toThrow(/not right/i);
    });

    it('is rate limited', async () => {
      await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });

      for (let i = 0; i < LIMITS.authVerify.limit; i += 1) {
        await useCases.verifyLoginCode
          .execute({ identifier: EMAIL, code: '000000', ip: IP })
          .catch(() => undefined);
      }

      await expect(
        useCases.verifyLoginCode.execute({ identifier: EMAIL, code: '000000', ip: IP }),
      ).rejects.toThrow(/too many/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('sessions', () => {
    it('refreshes and rotates', async () => {
      const registered = await register();
      const first = registered.tokens.refreshToken;

      const refreshed = await useCases.refreshSession.execute({ refreshToken: first });
      expect(refreshed.accessToken).toBeTruthy();
      expect(refreshed.refreshToken).not.toBe(first);

      // Replay of the consumed token fails — that is how a theft is detected.
      await expect(useCases.refreshSession.execute({ refreshToken: first })).rejects.toThrow(
        /session has expired/i,
      );
    });

    it('refuses an unknown refresh token', async () => {
      await expect(
        useCases.refreshSession.execute({ refreshToken: 'refresh.made-up' }),
      ).rejects.toThrow(/session has expired/i);
    });

    it('signs out one device without signing out the others', async () => {
      const phone = await register();
      // A second login is a second session for the same account.
      const laptopRequest = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      const laptop = await useCases.verifyLoginCode.execute({
        identifier: EMAIL,
        code: laptopRequest.devCode!,
        ip: IP,
      });

      const phoneActor = await useCases.authenticate.execute(phone.tokens.accessToken);
      await useCases.logout.execute({
        userId: phoneActor.user.id,
        sessionId: phoneActor.sessionId,
      });

      // Phone is dead...
      await expect(useCases.authenticate.execute(phone.tokens.accessToken)).rejects.toThrow(
        /session has expired/i,
      );
      // ...laptop is not.
      await expect(useCases.authenticate.execute(laptop.tokens.accessToken)).resolves.toBeTruthy();
    });

    it('signs out everywhere on request', async () => {
      const registered = await register();
      const actor = await useCases.authenticate.execute(registered.tokens.accessToken);

      await useCases.logout.execute({
        userId: actor.user.id,
        sessionId: actor.sessionId,
        allDevices: true,
      });

      await expect(
        useCases.refreshSession.execute({ refreshToken: registered.tokens.refreshToken }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('authenticating a request', () => {
    it('accepts a Bearer header and a bare token', () => {
      expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
      expect(extractBearerToken('bearer abc.def')).toBe('abc.def');
      expect(extractBearerToken('abc.def')).toBe('abc.def');
      expect(extractBearerToken(undefined)).toBeNull();
      expect(extractBearerToken('   ')).toBeNull();
      // Malformed: reject rather than guess.
      expect(extractBearerToken('Token abc def')).toBeNull();
    });

    it('returns the LOADED user, not the token claims', async () => {
      const registered = await register();
      const actor = await useCases.authenticate.execute(registered.tokens.accessToken);

      // Proof it read the database: fields the token does not carry.
      expect(actor.user.identifier).toBe(EMAIL);
      expect(actor.user.dob).toBeInstanceOf(Date);
    });

    it('rejects a refresh token presented as an access token', async () => {
      const registered = await register();
      await expect(useCases.authenticate.execute(registered.tokens.refreshToken)).rejects.toThrow(
        /session has expired/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('a banned account', () => {
    it('can pass the code check but receives no tokens', async () => {
      const registered = await register();
      await ports.users.updateStatus(registered.profile.id, 'banned');

      const requested = await useCases.requestLoginCode.execute({ identifier: EMAIL, ip: IP });
      // The code is still SENT — refusing at request time would leak status.
      expect(requested.sent).toBe(true);

      try {
        await useCases.verifyLoginCode.execute({
          identifier: EMAIL,
          code: requested.devCode!,
          ip: IP,
        });
        expect.unreachable('should have been refused');
      } catch (error) {
        expect((error as DomainError).code).toBe('BANNED');
      }
    });

    it('cannot refresh, and loses every session in the attempt', async () => {
      const registered = await register();
      await ports.users.updateStatus(registered.profile.id, 'banned');

      await expect(
        useCases.refreshSession.execute({ refreshToken: registered.tokens.refreshToken }),
      ).rejects.toThrow(/suspended/i);

      // The access token they still hold is dead too.
      await expect(useCases.authenticate.execute(registered.tokens.accessToken)).rejects.toThrow();
    });

    it('cannot authenticate an existing access token', async () => {
      const registered = await register();
      await ports.users.updateStatus(registered.profile.id, 'suspended');

      try {
        await useCases.authenticate.execute(registered.tokens.accessToken);
        expect.unreachable('should have been refused');
      } catch (error) {
        expect((error as DomainError).code).toBe('BANNED');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('profile', () => {
    it('shows the owner their masked identifier and trust ledger', async () => {
      const registered = await register();
      const user = (await ports.users.findById(registered.profile.id))!;
      const profile = await useCases.getMyProfile.execute(user);

      expect(profile.identifierMasked).toBe('pr***@example.com');
      // Never the full address, even to its owner.
      expect(profile.identifierMasked).not.toBe(EMAIL);
      expect(profile.tier).toBe('newcomer');
    });

    it('updates the display name', async () => {
      const registered = await register();
      const user = (await ports.users.findById(registered.profile.id))!;

      const updated = await useCases.updateMyProfile.execute(user, {
        displayName: '  Priya   S ',
      });
      expect(updated.displayName).toBe('Priya S');
    });

    it('regenerates an avatar with a server-chosen seed', async () => {
      const registered = await register();
      const user = (await ports.users.findById(registered.profile.id))!;

      const updated = await useCases.updateMyProfile.execute(user, { regenerateAvatar: true });
      expect(updated.avatarSeed).not.toBe(user.avatarSeed);
    });

    it('rejects an empty update', async () => {
      const registered = await register();
      const user = (await ports.users.findById(registered.profile.id))!;
      await expect(useCases.updateMyProfile.execute(user, {})).rejects.toThrow(
        /nothing to update/i,
      );
    });

    it('rejects a display name with a bidi override', async () => {
      const registered = await register();
      const user = (await ports.users.findById(registered.profile.id))!;
      await expect(
        useCases.updateMyProfile.execute(user, {
          displayName: `Priya${String.fromCodePoint(0x202e)}`,
        }),
      ).rejects.toThrow(/not allowed/i);
    });
  });
});
