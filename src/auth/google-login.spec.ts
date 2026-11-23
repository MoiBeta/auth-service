import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import {
  createAuthTestKit,
  fakeUser,
  flushBackground,
} from './testing/auth-test-kit';

describe('AuthService.loginWithGoogle', () => {
  let kit: Awaited<ReturnType<typeof createAuthTestKit>>;

  beforeEach(async () => {
    kit = await createAuthTestKit();
  });

  it('creates an account on first sign-in, with the email verified', async () => {
    const res = await kit.service.loginWithGoogle('token');

    expect(kit.users).toHaveLength(1);
    expect(kit.users[0]).toMatchObject({
      email: 'ana@gmail.com',
      name: 'Ana',
      googleId: 'google-123',
      password: null,
      emailVerified: true,
    });
    expect(res.user).toMatchObject({
      email: 'ana@gmail.com',
      isEmailConfirmed: true,
      hasPassword: false,
    });
    expect(res.tokens.accessToken).toBeDefined();
    expect(kit.users[0].hashedRt).not.toBeNull();
  });

  it('signs in to the same account next time', async () => {
    await kit.service.loginWithGoogle('token');
    const res = await kit.service.loginWithGoogle('token');

    expect(kit.users).toHaveLength(1);
    expect(res.user.id).toBe(kit.users[0].id);
  });

  it('links a verified account and keeps its password', async () => {
    kit.users.push(
      fakeUser({
        name: 'Ana P',
        emailVerified: true,
        password: await bcrypt.hash('secret1', 4),
      }),
    );

    const res = await kit.service.loginWithGoogle('token');

    expect(kit.users).toHaveLength(1);
    expect(res.user).toMatchObject({ id: 'existing', hasPassword: true });
    expect(kit.users[0].googleId).toBe('google-123');
    expect(kit.users[0].credentialsVersion).toBe(0);
    // Both methods keep working.
    await expect(
      kit.service.login('ana@gmail.com', 'secret1'),
    ).resolves.toBeDefined();
    await expect(kit.service.loginWithGoogle('token')).resolves.toBeDefined();
  });

  it('removes the password and the open session of an unverified account', async () => {
    kit.users.push(
      fakeUser({
        password: await bcrypt.hash('attacker', 4),
        hashedRt: 'old-session',
      }),
    );
    await kit.service.requestPasswordReset('ana@gmail.com');
    await flushBackground();
    expect(kit.emailCodes).toHaveLength(1);

    const res = await kit.service.loginWithGoogle('token');

    expect(kit.users[0]).toMatchObject({
      password: null,
      emailVerified: true,
      credentialsVersion: 1,
    });
    // Pending codes no longer apply.
    expect(kit.emailCodes).toHaveLength(0);
    expect(kit.users[0].hashedRt).not.toBe('old-session');
    expect(kit.cvOf(res.tokens.accessToken)).toBe(1);
    await expect(
      kit.service.login('ana@gmail.com', 'attacker'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an email linked to another Google account', async () => {
    kit.users.push(fakeUser({ googleId: 'google-other', emailVerified: true }));

    await expect(kit.service.loginWithGoogle('token')).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects a password login for an account without password', async () => {
    await kit.service.loginWithGoogle('token');

    await expect(kit.service.login('ana@gmail.com', '')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('GoogleIdTokenVerifier', () => {
  const payload = {
    sub: 'google-123',
    email: 'Ana@Gmail.com',
    email_verified: true,
    name: 'Ana',
  };

  const verifierWith = (clientId?: string) =>
    new GoogleIdTokenVerifier({
      get: () => clientId,
    } as unknown as ConfigService);

  const mockGoogle = (result: object | Error) =>
    jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockImplementation((() =>
        result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve({ getPayload: () => result })) as never);

  afterEach(() => jest.restoreAllMocks());

  it('returns the identity of a valid token, with the email lowercased', async () => {
    const spy = mockGoogle(payload);

    await expect(verifierWith('web-client-id').verify('t')).resolves.toEqual({
      googleId: 'google-123',
      email: 'ana@gmail.com',
      name: 'Ana',
    });
    expect(spy).toHaveBeenCalledWith({
      idToken: 't',
      audience: 'web-client-id',
    });
  });

  it('rejects a token Google does not accept', async () => {
    mockGoogle(
      new Error('Wrong recipient, payload audience != requiredAudience'),
    );

    await expect(verifierWith('web-client-id').verify('t')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an email Google has not verified', async () => {
    mockGoogle({ ...payload, email_verified: false });

    await expect(verifierWith('web-client-id').verify('t')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('reports when the client ID is not configured', async () => {
    await expect(verifierWith(undefined).verify('t')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
