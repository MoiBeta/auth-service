import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_TTL_MINUTES,
} from './email-code.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtStrategy } from './strategies/jwt.strategy';
import { createAuthTestKit } from './testing/auth-test-kit';

type Kit = Awaited<ReturnType<typeof createAuthTestKit>>;

const register = (kit: Kit, email = 'Ana@Gmail.com ') =>
  kit.service.register('Ana', email, 'secret1');

const wrongCode = (code: string) =>
  ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

describe('Emails are stored lowercased', () => {
  let kit: Kit;
  beforeEach(async () => (kit = await createAuthTestKit()));

  it('on registration, and are found in any case', async () => {
    const res = await register(kit);

    expect(kit.users[0].email).toBe('ana@gmail.com');
    expect(res.user.email).toBe('ana@gmail.com');
    await expect(
      kit.service.login('ANA@gmail.COM', 'secret1'),
    ).resolves.toBeDefined();
  });

  it('so the same email cannot be registered twice in another case', async () => {
    await register(kit);

    await expect(register(kit, 'ana@GMAIL.com')).rejects.toThrow(
      ConflictException,
    );
  });

  it('by the request DTOs too', async () => {
    const login = plainToInstance(LoginDto, {
      email: ' Ana@Gmail.com',
      password: 'x',
    });
    const reg = plainToInstance(RegisterDto, {
      name: 'Ana',
      email: 'ANA@GMAIL.COM ',
      password: 'secret1',
    });

    expect(login.email).toBe('ana@gmail.com');
    expect(reg.email).toBe('ana@gmail.com');
    expect(await validate(login)).toHaveLength(0);
    expect(await validate(reg)).toHaveLength(0);
  });
});

describe('Email verification', () => {
  let kit: Kit;
  let userId: string;
  const code = () => kit.sentCodes.at(-1)!.code;

  beforeEach(async () => {
    kit = await createAuthTestKit();
    userId = (await register(kit)).user.id;
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends a 6-digit code on registration, unverified until used', () => {
    expect(kit.sentCodes).toHaveLength(1);
    expect(kit.sentCodes[0].to).toBe('ana@gmail.com');
    expect(code()).toMatch(/^\d{6}$/);
    expect(kit.users[0].emailVerified).toBe(false);
    // Only its hash is stored.
    expect(kit.emailCodes).toHaveLength(1);
    expect(kit.emailCodes[0].codeHash).not.toBe(code());
  });

  it('verifies the email with the code', async () => {
    const user = await kit.service.verifyEmail(userId, code());

    expect(user.isEmailConfirmed).toBe(true);
    expect(kit.users[0].emailVerified).toBe(true);
    expect(kit.emailCodes).toHaveLength(0);
    // Verifying again is harmless.
    await expect(
      kit.service.verifyEmail(userId, '000000'),
    ).resolves.toMatchObject({ isEmailConfirmed: true });
  });

  it('rejects a wrong code', async () => {
    await expect(
      kit.service.verifyEmail(userId, wrongCode(code())),
    ).rejects.toThrow(BadRequestException);
    expect(kit.users[0].emailVerified).toBe(false);
  });

  it('stops accepting the code after too many wrong guesses', async () => {
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      await expect(
        kit.service.verifyEmail(userId, wrongCode(code())),
      ).rejects.toThrow('Invalid code');
    }

    await expect(kit.service.verifyEmail(userId, code())).rejects.toThrow(
      'Too many attempts, request a new code',
    );
  });

  it('rejects an expired code', async () => {
    const now = Date.now();
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(now + EMAIL_CODE_TTL_MINUTES * 60_000 + 1);

    await expect(kit.service.verifyEmail(userId, code())).rejects.toThrow(
      'The code has expired, request a new one',
    );
  });

  it('resends a new code, which replaces the old one', async () => {
    const first = code();
    await expect(kit.service.resendEmailCode(userId)).rejects.toThrow(
      HttpException,
    );

    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + EMAIL_CODE_RESEND_COOLDOWN_MS + 1);
    await kit.service.resendEmailCode(userId);

    expect(kit.sentCodes).toHaveLength(2);
    if (code() !== first) {
      await expect(kit.service.verifyEmail(userId, first)).rejects.toThrow(
        'Invalid code',
      );
    }
    await expect(
      kit.service.verifyEmail(userId, code()),
    ).resolves.toMatchObject({ isEmailConfirmed: true });
  });

  it('asks to wait between codes', async () => {
    const error: unknown = await kit.service
      .resendEmailCode(userId)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('does not resend once verified', async () => {
    await kit.service.verifyEmail(userId, code());

    await expect(kit.service.resendEmailCode(userId)).rejects.toThrow(
      ConflictException,
    );
  });

  it('registers the account even if the email cannot be sent', async () => {
    kit.mail.sendVerificationCode.mockRejectedValueOnce(new Error('SMTP down'));

    const res = await register(kit, 'bea@gmail.com');

    expect(res.tokens.accessToken).toBeDefined();
    expect(res.user.isEmailConfirmed).toBe(false);
  });
});

describe('Signing in with both methods', () => {
  let kit: Kit;
  beforeEach(async () => (kit = await createAuthTestKit()));

  it('a verified account linked to Google keeps both methods', async () => {
    const { user } = await register(kit);
    await kit.service.verifyEmail(user.id, kit.sentCodes[0].code);

    const google = await kit.service.loginWithGoogle('token');

    expect(google.user).toMatchObject({ id: user.id, hasPassword: true });
    await expect(
      kit.service.login('ana@gmail.com', 'secret1'),
    ).resolves.toBeDefined();
  });

  it('a Google account can add a password and then sign in with it', async () => {
    const { user, tokens } = await kit.service.loginWithGoogle('token');

    const updated = await kit.service.setPassword(
      user.id,
      kit.cvOf(tokens.accessToken),
      'newpass1',
    );

    expect(updated.hasPassword).toBe(true);
    await expect(
      kit.service.login('ana@gmail.com', 'newpass1'),
    ).resolves.toBeDefined();
    await expect(kit.service.loginWithGoogle('token')).resolves.toBeDefined();
  });

  it('a password cannot be added twice', async () => {
    const { user, tokens } = await kit.service.loginWithGoogle('token');
    const cv = kit.cvOf(tokens.accessToken);
    await kit.service.setPassword(user.id, cv, 'newpass1');

    await expect(
      kit.service.setPassword(user.id, cv, 'another1'),
    ).rejects.toThrow(ConflictException);
    await expect(
      kit.service.login('ana@gmail.com', 'newpass1'),
    ).resolves.toBeDefined();
  });

  it('whoever registered an unverified email cannot take it back', async () => {
    // Someone registers with Ana's email, then Ana signs in with Google.
    const attacker = await register(kit);
    const ana = await kit.service.loginWithGoogle('token');

    // The attacker's access token is still unexpired, but predates the link.
    await expect(
      kit.service.setPassword(
        attacker.user.id,
        kit.cvOf(attacker.tokens.accessToken),
        'attacker',
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      kit.service.refreshTokens(attacker.user.id, attacker.tokens.refreshToken),
    ).rejects.toThrow(UnauthorizedException);

    // Ana can set her own.
    await kit.service.setPassword(
      ana.user.id,
      kit.cvOf(ana.tokens.accessToken),
      'anaspass',
    );
    await expect(
      kit.service.login('ana@gmail.com', 'anaspass'),
    ).resolves.toBeDefined();
  });

  it('a token from before credentialsVersion existed must be renewed', async () => {
    const { user } = await kit.service.loginWithGoogle('token');

    await expect(
      kit.service.setPassword(user.id, undefined, 'newpass1'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('the access token strategy passes the version on', async () => {
    const strategy = new JwtStrategy({ get: () => 'secret' } as never);

    await expect(
      strategy.validate({ id: 'u1', email: 'a@b.co', cv: 3 }),
    ).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.co',
      credentialsVersion: 3,
    });
  });
});
