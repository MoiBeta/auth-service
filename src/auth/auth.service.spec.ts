import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';

describe('AuthService refresh token rotation', () => {
  let service: AuthService;
  const user = {
    id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
    email: 'user@example.com',
    name: 'User',
    role: 'USER',
    password: 'x',
    hashedRt: null as string | null,
  };

  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ ...user })),
      update: jest.fn(async ({ data }: { data: { hashedRt: string | null } }) => {
        user.hashedRt = data.hashedRt;
        return { ...user };
      }),
    },
  };

  const config = {
    getOrThrow: (key: string) =>
      ({
        JWT_SECRET: 'access-secret',
        JWT_EXPIRES_IN: '15m',
        JWT_REFRESH_SECRET: 'refresh-secret',
        JWT_REFRESH_EXPIRES_IN: '7d',
      })[key],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        JwtService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: GoogleIdTokenVerifier, useValue: {} },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('rejects a refresh token after it has been rotated', async () => {
    // Two tokens for the same user share their first 72 bytes, which is all
    // bcrypt would have compared.
    const jwt = new JwtService();
    const oldToken = jwt.sign(
      { id: user.id, email: user.email, n: 1 },
      { secret: 'refresh-secret' },
    );
    await (service as any).updateRtHash(user.id, oldToken);

    const { tokens } = await service.refreshTokens(user.id, oldToken);
    expect(tokens.refreshToken).not.toEqual(oldToken);

    await expect(service.refreshTokens(user.id, oldToken)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      service.refreshTokens(user.id, tokens.refreshToken),
    ).resolves.toBeDefined();
  });
});
