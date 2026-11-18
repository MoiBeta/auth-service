import { Test } from '@nestjs/testing';
import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  GoogleIdTokenVerifier,
  GoogleIdentity,
} from './google-id-token.verifier';

type User = {
  id: string;
  name: string;
  email: string;
  password: string | null;
  googleId: string | null;
  role: string;
  hashedRt: string | null;
};

/** In-memory stand-in for the parts of Prisma that AuthService uses. */
function fakePrisma(users: User[]) {
  const matches = (u: User, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) =>
      typeof value === 'object' && value !== null
        ? String(u[key as keyof User]).toLowerCase() ===
          String(value.equals).toLowerCase()
        : u[key as keyof User] === value,
    );

  return {
    user: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(users.find((u) => matches(u, where)) ?? null),
      ),
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(users.find((u) => matches(u, where)) ?? null),
      ),
      create: jest.fn(({ data }) => {
        const user: User = {
          id: `user-${users.length + 1}`,
          name: '',
          password: null,
          googleId: null,
          role: 'USER',
          hashedRt: null,
          ...data,
        };
        users.push(user);
        return Promise.resolve(user);
      }),
      update: jest.fn(({ where, data }) => {
        const user = users.find((u) => matches(u, where))!;
        Object.assign(user, data);
        return Promise.resolve(user);
      }),
    },
  };
}

const config = {
  get: (key: string) =>
    (({ GOOGLE_CLIENT_ID: 'web-client-id' }) as Record<string, string>)[key],
  getOrThrow: (key: string) =>
    ({
      JWT_SECRET: 'access-secret',
      JWT_EXPIRES_IN: '15m',
      JWT_REFRESH_SECRET: 'refresh-secret',
      JWT_REFRESH_EXPIRES_IN: '7d',
    })[key],
};

describe('AuthService.loginWithGoogle', () => {
  const identity: GoogleIdentity = {
    googleId: 'google-123',
    email: 'ana@gmail.com',
    name: 'Ana',
  };

  let users: User[];
  let service: AuthService;

  beforeEach(async () => {
    users = [];
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        JwtService,
        { provide: PrismaService, useValue: fakePrisma(users) },
        { provide: ConfigService, useValue: config },
        {
          provide: GoogleIdTokenVerifier,
          useValue: { verify: jest.fn().mockResolvedValue(identity) },
        },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('creates an account on first sign-in', async () => {
    const res = await service.loginWithGoogle('token');

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: 'ana@gmail.com',
      name: 'Ana',
      googleId: 'google-123',
      password: null,
    });
    expect(res.user.email).toBe('ana@gmail.com');
    expect(res.tokens.accessToken).toBeDefined();
    expect(users[0].hashedRt).not.toBeNull();
  });

  it('signs in to the same account next time', async () => {
    await service.loginWithGoogle('token');
    const res = await service.loginWithGoogle('token');

    expect(users).toHaveLength(1);
    expect(res.user.id).toBe(users[0].id);
  });

  it('links an account registered with the same email, in any case', async () => {
    users.push({
      id: 'existing',
      name: 'Ana P',
      email: 'Ana@Gmail.com',
      password: 'bcrypt-hash',
      googleId: null,
      role: 'USER',
      hashedRt: 'old-session',
    });

    const res = await service.loginWithGoogle('token');

    expect(users).toHaveLength(1);
    expect(res.user.id).toBe('existing');
    expect(users[0].googleId).toBe('google-123');
  });

  it('removes the password and the open session when linking', async () => {
    users.push({
      id: 'existing',
      name: '',
      email: 'ana@gmail.com',
      password: 'bcrypt-hash',
      googleId: null,
      role: 'USER',
      hashedRt: 'old-session',
    });

    await service.loginWithGoogle('token');

    expect(users[0].password).toBeNull();
    expect(users[0].hashedRt).not.toBe('old-session');
    await expect(service.login('ana@gmail.com', 'anything')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an email linked to another Google account', async () => {
    users.push({
      id: 'existing',
      name: '',
      email: 'ana@gmail.com',
      password: null,
      googleId: 'google-other',
      role: 'USER',
      hashedRt: null,
    });

    await expect(service.loginWithGoogle('token')).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects a password login for an account without password', async () => {
    await service.loginWithGoogle('token');

    await expect(service.login('ana@gmail.com', '')).rejects.toThrow(
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
