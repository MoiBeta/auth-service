import { HttpException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODES_PER_DAY,
} from './email-code.service';
import {
  createAuthTestKit,
  fakeUser,
  flushBackground,
} from './testing/auth-test-kit';

type Kit = Awaited<ReturnType<typeof createAuthTestKit>>;

const GENERIC = {
  message: 'If the email has an account, a code was sent to it',
};

describe('Password reset', () => {
  let kit: Kit;
  let now: number;

  /** Moves the clock forward, past the wait between codes by default. */
  const advance = (ms = EMAIL_CODE_RESEND_COOLDOWN_MS + 1) => {
    now += ms;
  };

  const forgot = async (email = 'ana@gmail.com') => {
    const res = await kit.service.requestPasswordReset(email);
    await flushBackground();
    return res;
  };

  beforeEach(async () => {
    kit = await createAuthTestKit();
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    kit.users.push(
      fakeUser({
        id: 'ana',
        emailVerified: true,
        password: await bcrypt.hash('oldpass', 4),
        hashedRt: 'open-session',
      }),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends a reset code to an existing account', async () => {
    expect(await forgot('Ana@Gmail.com')).toEqual(GENERIC);

    expect(kit.sentCodes).toEqual([
      {
        to: 'ana@gmail.com',
        code: expect.any(String) as string,
        purpose: 'reset',
      },
    ]);
  });

  it('answers the same for an email without account, and sends nothing', async () => {
    expect(await forgot('nobody@gmail.com')).toEqual(GENERIC);

    expect(kit.sentCodes).toHaveLength(0);
  });

  it('answers even if the email cannot be sent', async () => {
    kit.mail.sendPasswordResetCode.mockRejectedValueOnce(
      new Error('SMTP down'),
    );

    await expect(forgot()).resolves.toEqual(GENERIC);
  });

  it('sets the new password with the code and signs in', async () => {
    await forgot();

    const res = await kit.service.resetPassword(
      'ANA@gmail.com',
      kit.lastCode('reset')!,
      'newpass1',
    );

    expect(res.tokens.accessToken).toBeDefined();
    expect(res.user).toMatchObject({ id: 'ana', hasPassword: true });
    await expect(
      kit.service.login('ana@gmail.com', 'newpass1'),
    ).resolves.toBeDefined();
    await expect(kit.service.login('ana@gmail.com', 'oldpass')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('a code works only once', async () => {
    await forgot();
    const code = kit.lastCode('reset')!;
    await kit.service.resetPassword('ana@gmail.com', code, 'newpass1');

    await expect(
      kit.service.resetPassword('ana@gmail.com', code, 'another1'),
    ).rejects.toThrow('The code has expired, request a new one');
  });

  it('rejects a wrong code, and an email without account', async () => {
    await forgot();
    const wrong = kit.lastCode('reset') === '000000' ? '000001' : '000000';

    await expect(
      kit.service.resetPassword('ana@gmail.com', wrong, 'newpass1'),
    ).rejects.toThrow('Invalid code');
    await expect(
      kit.service.resetPassword('nobody@gmail.com', '123456', 'newpass1'),
    ).rejects.toThrow('The code has expired, request a new one');
  });

  it('a verification code cannot reset the password, nor the reverse', async () => {
    kit.users[0].emailVerified = false;
    await kit.service.resendEmailCode('ana');
    advance();
    await forgot();

    await expect(
      kit.service.resetPassword(
        'ana@gmail.com',
        kit.lastCode('verify')!,
        'newpass1',
      ),
    ).rejects.toThrow();
    if (kit.lastCode('reset') !== kit.lastCode('verify')) {
      await expect(
        kit.service.verifyEmail('ana', kit.lastCode('reset')!),
      ).rejects.toThrow('Invalid code');
    }
  });

  it('ends the other sessions', async () => {
    const old = await kit.service.login('ana@gmail.com', 'oldpass');
    await forgot();

    const res = await kit.service.resetPassword(
      'ana@gmail.com',
      kit.lastCode('reset')!,
      'newpass1',
    );

    await expect(
      kit.service.refreshTokens('ana', old.tokens.refreshToken),
    ).rejects.toThrow(UnauthorizedException);
    expect(kit.cvOf(res.tokens.accessToken)).toBe(1);
    // An access token from before cannot set a password either.
    expect(kit.cvOf(old.tokens.accessToken)).toBe(0);
  });

  it('gives the account back to the owner of the email', async () => {
    // Someone registered with Ana's email before her.
    kit.users.length = 0;
    const attacker = await kit.service.register(
      'X',
      'ana@gmail.com',
      'attacker',
    );
    advance();

    await forgot();
    await kit.service.resetPassword(
      'ana@gmail.com',
      kit.lastCode('reset')!,
      'anaspass',
    );

    expect(kit.users[0].emailVerified).toBe(true);
    await expect(
      kit.service.login('ana@gmail.com', 'attacker'),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      kit.service.refreshTokens(attacker.user.id, attacker.tokens.refreshToken),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      kit.service.setPassword(
        attacker.user.id,
        kit.cvOf(attacker.tokens.accessToken),
        'attacker2',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('lets an account created with Google get a password', async () => {
    kit.users.length = 0;
    await kit.service.loginWithGoogle('token');

    await forgot();
    await kit.service.resetPassword(
      'ana@gmail.com',
      kit.lastCode('reset')!,
      'newpass1',
    );

    await expect(
      kit.service.login('ana@gmail.com', 'newpass1'),
    ).resolves.toBeDefined();
    await expect(kit.service.loginWithGoogle('token')).resolves.toBeDefined();
  });

  it('waits between codes', async () => {
    await forgot();
    await forgot();

    expect(kit.sentCodes).toHaveLength(1);
  });
});

describe('Codes sent per day', () => {
  let kit: Kit;
  let now: number;

  beforeEach(async () => {
    kit = await createAuthTestKit();
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  it('are capped for password resets, until a day has passed', async () => {
    kit.users.push(fakeUser({ id: 'ana' }));

    for (let i = 0; i < EMAIL_CODES_PER_DAY + 2; i++) {
      await kit.service.requestPasswordReset('ana@gmail.com');
      await flushBackground();
      now += EMAIL_CODE_RESEND_COOLDOWN_MS + 1;
    }
    expect(kit.sentCodes).toHaveLength(EMAIL_CODES_PER_DAY);

    now += 24 * 60 * 60_000;
    await kit.service.requestPasswordReset('ana@gmail.com');
    await flushBackground();
    expect(kit.sentCodes).toHaveLength(EMAIL_CODES_PER_DAY + 1);
  });

  it('are capped for verification, counting the one sent on registration', async () => {
    const { user } = await kit.service.register(
      'Ana',
      'ana@gmail.com',
      'pw1234',
    );

    for (let i = 1; i < EMAIL_CODES_PER_DAY; i++) {
      now += EMAIL_CODE_RESEND_COOLDOWN_MS + 1;
      await kit.service.resendEmailCode(user.id);
    }
    now += EMAIL_CODE_RESEND_COOLDOWN_MS + 1;

    await expect(kit.service.resendEmailCode(user.id)).rejects.toThrow(
      new HttpException('Too many codes today, try again tomorrow', 429),
    );
    expect(kit.sentCodes).toHaveLength(EMAIL_CODES_PER_DAY);
  });
});
