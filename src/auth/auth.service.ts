import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StringValue } from 'ms';
import { AuthResponseDto } from './dto/auth.response.dto';
import { UserResponseDto } from './dto/user.response.dto';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import { MailService } from '../mail/mail.service';
import { normalizeEmail } from './email';
import {
  CheckResult,
  EMAIL_CODE_TTL_MINUTES,
  EmailCodePurpose,
  EmailCodeService,
  hashMatches,
  sha256,
} from './email-code.service';

/** What a rejected code is reported as. */
const CODE_ERRORS: Record<Exclude<CheckResult, 'ok'>, string> = {
  invalid: 'Invalid code',
  expired: 'The code has expired, request a new one',
  'too-many-attempts': 'Too many attempts, request a new code',
};

type UserRecord = {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerified: boolean;
  password: string | null;
  credentialsVersion: number;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
    private config: ConfigService,
    private googleVerifier: GoogleIdTokenVerifier,
    private mail: MailService,
    private emailCodes: EmailCodeService,
  ) {}

  async register(name: string, email: string, password: string) {
    email = normalizeEmail(email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
      },
    });

    // The account is usable right away; the email is verified afterwards.
    // A failure to send must not undo the registration: the user can ask for
    // another code.
    await this.sendCode(user, EmailCodePurpose.VERIFY_EMAIL).catch((e) =>
      this.logger.error(`Could not send the verification code: ${e}`),
    );

    return this.startSession(user);
  }

  async login(email: string, password: string) {
    email = normalizeEmail(email);
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Accounts created with Google have no password.
    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.startSession(user);
  }

  /**
   * Signs in with a Google ID token, creating the account on first use.
   *
   * An existing account with the same email is linked to the Google account,
   * and from then on both sign-in methods work, as long as its email was
   * verified. An unverified account could have been created by anyone with
   * someone else's address and a password of their own; Google has verified
   * that the email belongs to the person signing in now, so in that case the
   * password and the open session are removed and the tokens issued before
   * are no longer accepted where it matters (credentialsVersion). The owner
   * can set a password of their own afterwards.
   */
  async loginWithGoogle(idToken: string) {
    const { googleId, email, name } = await this.googleVerifier.verify(idToken);

    let user = await this.prisma.user.findUnique({ where: { googleId } });

    if (!user) {
      const existing = await this.prisma.user.findUnique({
        where: { email: normalizeEmail(email) },
      });

      if (existing?.googleId) {
        // The email now belongs to a different Google account.
        throw new ConflictException(
          'This email is linked to another Google account',
        );
      }

      if (!existing) {
        user = await this.prisma.user.create({
          data: {
            googleId,
            email: normalizeEmail(email),
            name,
            emailVerified: true,
          },
        });
      } else if (existing.emailVerified) {
        user = await this.prisma.user.update({
          where: { id: existing.id },
          data: { googleId },
        });
      } else {
        user = await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            googleId,
            emailVerified: true,
            password: null,
            hashedRt: null,
            credentialsVersion: { increment: 1 },
          },
        });
        // Including any reset code requested by whoever set the password.
        await this.emailCodes.clear(user.id);
      }
    }

    return this.startSession(user);
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException();
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isEmailConfirmed: user.emailVerified,
      hasPassword: user.password !== null,
    };
  }

  /** Sends a new verification code to the account's email. */
  async resendEmailCode(userId: string) {
    const user = await this.findUserOrThrow(userId);
    if (user.emailVerified) {
      throw new ConflictException('The email is already verified');
    }

    const refused = await this.sendCode(user, EmailCodePurpose.VERIFY_EMAIL);
    if (refused) {
      throw new HttpException(
        refused === 'cooldown'
          ? 'Wait a minute before requesting another code'
          : 'Too many codes today, try again tomorrow',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { message: 'Verification code sent' };
  }

  async verifyEmail(userId: string, code: string) {
    const user = await this.findUserOrThrow(userId);
    if (user.emailVerified) {
      return this.buildUserResponse(user);
    }

    await this.checkCode(user.id, EmailCodePurpose.VERIFY_EMAIL, code);

    const verified = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
    await this.emailCodes.clear(user.id, EmailCodePurpose.VERIFY_EMAIL);
    return this.buildUserResponse(verified);
  }

  /**
   * Sends a code to reset the password, if the email has an account. The
   * answer is the same either way, and so is the time it takes: the email
   * is sent in the background.
   */
  async requestPasswordReset(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });

    if (user) {
      void this.sendCode(user, EmailCodePurpose.RESET_PASSWORD).catch((e) =>
        this.logger.error(`Could not send the password reset code: ${e}`),
      );
    }

    return { message: 'If the email has an account, a code was sent to it' };
  }

  /**
   * Sets a new password with the code sent to the email, and signs in.
   *
   * Getting the code proves the email is the user's, so it also counts as
   * verifying it. Whoever else had access loses it: the open session is
   * removed and earlier tokens stop working where it matters.
   */
  async resetPassword(email: string, code: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
    if (!user) {
      // Same as an account with no code pending.
      throw new BadRequestException(CODE_ERRORS.expired);
    }

    await this.checkCode(user.id, EmailCodePurpose.RESET_PASSWORD, code);

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(password, 10),
        emailVerified: true,
        hashedRt: null,
        credentialsVersion: { increment: 1 },
      },
    });
    await this.emailCodes.clear(user.id);

    return this.startSession(updated);
  }

  /**
   * Adds a password to an account that has none (created with Google), so it
   * can also sign in with email and password.
   *
   * The token must have been issued after the last change of hands: when an
   * unverified password is removed on linking Google, whoever had set it may
   * still hold an access token for a few minutes, and must not be able to
   * set a new password with it.
   */
  async setPassword(
    userId: string,
    credentialsVersion: number | undefined,
    password: string,
  ) {
    const user = await this.findUserOrThrow(userId);

    if (credentialsVersion !== user.credentialsVersion) {
      throw new UnauthorizedException('Token issued before the last change');
    }
    if (user.password) {
      throw new ConflictException('The account already has a password');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    // Conditional, so two parallel requests cannot both set it.
    const { count } = await this.prisma.user.updateMany({
      where: { id: user.id, password: null, credentialsVersion },
      data: { password: hashedPassword },
    });
    if (count === 0) {
      throw new ConflictException('The account already has a password');
    }

    return this.buildUserResponse({ ...user, password: hashedPassword });
  }

  async refreshTokens(userId: string, refreshToken: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.hashedRt) {
      throw new UnauthorizedException();
    }

    if (!this.refreshTokenMatches(refreshToken, user.hashedRt)) {
      throw new UnauthorizedException();
    }

    return this.startSession(user);
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedRt: null },
    });

    return { message: 'Logged out successfully' };
  }

  private async startSession(user: UserRecord): Promise<AuthResponseDto> {
    const tokens = await this.getTokens(user);

    await this.updateRtHash(user.id, tokens.refreshToken);

    return {
      user: this.buildUserResponse(user),
      tokens,
    };
  }

  private async findUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }

  /** Sends a new code; returns why not, if it was refused. */
  private async sendCode(
    user: { id: string; email: string },
    purpose: EmailCodePurpose,
  ) {
    const result = await this.emailCodes.issue(user.id, purpose);
    if ('refused' in result) {
      return result.refused;
    }

    if (purpose === EmailCodePurpose.VERIFY_EMAIL) {
      await this.mail.sendVerificationCode(
        user.email,
        result.code,
        EMAIL_CODE_TTL_MINUTES,
      );
    } else {
      await this.mail.sendPasswordResetCode(
        user.email,
        result.code,
        EMAIL_CODE_TTL_MINUTES,
      );
    }
    return undefined;
  }

  private async checkCode(
    userId: string,
    purpose: EmailCodePurpose,
    code: string,
  ) {
    const result = await this.emailCodes.check(userId, purpose, code);
    if (result !== 'ok') {
      throw new BadRequestException(CODE_ERRORS[result]);
    }
  }

  private async getTokens(user: UserRecord) {
    // cv: see setPassword.
    const payload = {
      id: user.id,
      email: user.email,
      cv: user.credentialsVersion,
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.config.getOrThrow<string>('JWT_SECRET') as StringValue,
        expiresIn: this.config.getOrThrow<string>(
          'JWT_EXPIRES_IN',
        ) as StringValue,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.config.getOrThrow<string>(
          'JWT_REFRESH_SECRET',
        ) as StringValue,
        expiresIn: this.config.getOrThrow<string>(
          'JWT_REFRESH_EXPIRES_IN',
        ) as StringValue,
      }),
    ]);

    return {
      accessToken: accessToken,
      refreshToken: refreshToken,
    };
  }

  private buildUserResponse(user: UserRecord): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      fullName: user.name,
      role: user.role,
      isEmailConfirmed: user.emailVerified,
      hasPassword: user.password !== null,
    };
  }

  // Refresh tokens are hashed with SHA-256. bcrypt only uses the first 72
  // bytes, which are identical for every JWT of the same user.
  private refreshTokenMatches(refreshToken: string, storedHash: string) {
    return hashMatches(refreshToken, storedHash);
  }

  private async updateRtHash(userId: string, refreshToken: string) {
    const hash = sha256(refreshToken);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        hashedRt: hash,
      },
    });
  }
}
