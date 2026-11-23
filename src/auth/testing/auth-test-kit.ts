import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GoogleIdTokenVerifier,
  GoogleIdentity,
} from '../google-id-token.verifier';
import { MailService } from '../../mail/mail.service';
import { EmailCodeService } from '../email-code.service';

type Row = Record<string, unknown>;

export type FakeUser = Row & {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  password: string | null;
  googleId: string | null;
  role: string;
  credentialsVersion: number;
  hashedRt: string | null;
};

export type FakeEmailCode = Row & {
  id: string;
  userId: string;
  purpose: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
};

export function fakeUser(fields: Partial<FakeUser>): FakeUser {
  return {
    id: 'existing',
    name: '',
    email: 'ana@gmail.com',
    emailVerified: false,
    password: null,
    googleId: null,
    role: 'USER',
    credentialsVersion: 0,
    hashedRt: null,
    ...fields,
  };
}

type Query = { where: Row; data: Row };

const isOp = <K extends string>(
  value: unknown,
  op: K,
): value is Record<K, number | Date> =>
  value !== null && typeof value === 'object' && op in value;

const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) =>
    isOp(value, 'lt')
      ? (row[key] as number | Date) < value.lt
      : row[key] === value,
  );

const apply = <T extends Row>(row: T, data: Row) => {
  for (const [key, value] of Object.entries(data)) {
    (row as Row)[key] = isOp(value, 'increment')
      ? (row[key] as number) + (value.increment as number)
      : value;
  }
  return row;
};

/**
 * In-memory stand-in for one Prisma model, with the queries AuthService
 * uses. Ordering is always newest first by createdAt.
 */
function fakeTable<T extends Row>(rows: T[], create: (data: Row) => T) {
  const newestFirst = (list: T[]) =>
    [...list].sort(
      (a, b) =>
        ((b.createdAt as Date | undefined)?.getTime() ?? 0) -
        ((a.createdAt as Date | undefined)?.getTime() ?? 0),
    );
  const filter = (where: Row) =>
    newestFirst(rows.filter((r) => matches(r, where)));
  const find = ({ where }: { where: Row }) =>
    Promise.resolve(filter(where)[0] ?? null);

  return {
    findUnique: jest.fn(find),
    findFirst: jest.fn(find),
    findMany: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(filter(where)),
    ),
    create: jest.fn(({ data }: { data: Row }) => {
      const row = create(data);
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(({ where, data }: Query) =>
      Promise.resolve(apply(rows.find((r) => matches(r, where))!, data)),
    ),
    updateMany: jest.fn(({ where, data }: Query) => {
      const found = rows.filter((r) => matches(r, where));
      found.forEach((r) => apply(r, data));
      return Promise.resolve({ count: found.length });
    }),
    deleteMany: jest.fn(({ where }: { where: Row }) => {
      const kept = rows.filter((r) => !matches(r, where));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return Promise.resolve({ count });
    }),
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

export const googleIdentity: GoogleIdentity = {
  googleId: 'google-123',
  email: 'ana@gmail.com',
  name: 'Ana',
};

type SentCode = { to: string; code: string; purpose: 'verify' | 'reset' };

/** AuthService over in-memory tables, with the emails it sends. */
export async function createAuthTestKit() {
  const users: FakeUser[] = [];
  const emailCodes: FakeEmailCode[] = [];
  const sentCodes: SentCode[] = [];
  const recorder = (purpose: SentCode['purpose']) =>
    jest.fn((to: string, code: string) => {
      sentCodes.push({ to, code, purpose });
      return Promise.resolve();
    });
  const mail = {
    sendVerificationCode: recorder('verify'),
    sendPasswordResetCode: recorder('reset'),
  };

  const prisma = {
    user: fakeTable(users, (data) =>
      fakeUser({ id: `user-${users.length + 1}`, ...data }),
    ),
    emailCode: fakeTable(
      emailCodes,
      (data) =>
        ({
          id: `code-${emailCodes.length + 1}-${Math.random()}`,
          attempts: 0,
          createdAt: new Date(),
          ...data,
        }) as FakeEmailCode,
    ),
  };

  const module = await Test.createTestingModule({
    providers: [
      AuthService,
      EmailCodeService,
      JwtService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
      { provide: MailService, useValue: mail },
      {
        provide: GoogleIdTokenVerifier,
        useValue: { verify: jest.fn().mockResolvedValue(googleIdentity) },
      },
    ],
  }).compile();

  const jwt = new JwtService();
  /** The credentials version carried by an access token. */
  const cvOf = (accessToken: string): number | undefined =>
    jwt.decode<{ cv?: number }>(accessToken).cv;

  /** The last code sent for [purpose]. */
  const lastCode = (purpose: SentCode['purpose']) =>
    sentCodes.filter((c) => c.purpose === purpose).at(-1)?.code;

  return {
    service: module.get(AuthService),
    users,
    emailCodes,
    sentCodes,
    lastCode,
    mail,
    cvOf,
  };
}

/** Lets the work started in the background (emails) finish. */
export const flushBackground = () =>
  new Promise((resolve) => setImmediate(resolve));
