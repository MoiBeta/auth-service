import { Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { EmailCodePurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export { EmailCodePurpose };

/** How long a code can be used. */
export const EMAIL_CODE_TTL_MINUTES = 15;
/** Wrong guesses allowed per code; a new code has to be requested after. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Minimum time between two codes of the same purpose to one account. */
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 60_000;
/**
 * Codes of the same purpose sent to one account in 24 hours. With the
 * attempts per code, it bounds the guesses at a 6-digit code to 25 a day,
 * however many codes are requested.
 */
export const EMAIL_CODES_PER_DAY = 5;

const DAY_MS = 24 * 60 * 60_000;

export type IssueResult =
  | { code: string }
  | { refused: 'cooldown' | 'daily-limit' };

export type CheckResult = 'ok' | 'invalid' | 'expired' | 'too-many-attempts';

/** One-time codes sent by email: to verify it, or to reset the password. */
@Injectable()
export class EmailCodeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a new code, which replaces the previous one of the same purpose.
   * Returns it in clear, to be sent; only its hash is stored.
   */
  async issue(userId: string, purpose: EmailCodePurpose): Promise<IssueResult> {
    const now = Date.now();

    await this.prisma.emailCode.deleteMany({
      where: { userId, purpose, createdAt: { lt: new Date(now - DAY_MS) } },
    });
    const sent = await this.prisma.emailCode.findMany({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (
      sent[0] &&
      now - sent[0].createdAt.getTime() < EMAIL_CODE_RESEND_COOLDOWN_MS
    ) {
      return { refused: 'cooldown' };
    }
    if (sent.length >= EMAIL_CODES_PER_DAY) {
      return { refused: 'daily-limit' };
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.emailCode.create({
      data: {
        userId,
        purpose,
        codeHash: sha256(code),
        createdAt: new Date(now),
        expiresAt: new Date(now + EMAIL_CODE_TTL_MINUTES * 60_000),
      },
    });
    return { code };
  }

  /** Checks a code against the latest one sent, spending an attempt. */
  async check(
    userId: string,
    purpose: EmailCodePurpose,
    code: string,
  ): Promise<CheckResult> {
    const latest = await this.prisma.emailCode.findFirst({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest || latest.expiresAt.getTime() < Date.now()) {
      return 'expired';
    }

    // The attempt is spent before checking, atomically, so parallel
    // requests cannot go over the limit.
    const { count } = await this.prisma.emailCode.updateMany({
      where: { id: latest.id, attempts: { lt: EMAIL_CODE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (count === 0) {
      return 'too-many-attempts';
    }

    return hashMatches(code, latest.codeHash) ? 'ok' : 'invalid';
  }

  /** Invalidates the codes of an account, once used or no longer needed. */
  async clear(userId: string, purpose?: EmailCodePurpose) {
    await this.prisma.emailCode.deleteMany({
      where: purpose ? { userId, purpose } : { userId },
    });
  }
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/** Compares a value with a stored SHA-256 hash in constant time. */
export function hashMatches(value: string, storedHash: string) {
  const candidate = Buffer.from(sha256(value));
  const stored = Buffer.from(storedHash);
  return (
    candidate.length === stored.length && timingSafeEqual(candidate, stored)
  );
}
