import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash, timingSafeEqual } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StringValue } from 'ms';
import { AuthResponseDto } from './dto/auth.response.dto';
import { UserResponseDto } from './dto/user.response.dto';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async register(name: string, email: string, password: string) {
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

    const tokens = await this.getTokens(user.id, user.email);

    await this.updateRtHash(user.id, tokens.refreshToken);

    return {
      user: this.buildUserResponse(user),
      tokens,
    } as AuthResponseDto;
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.getTokens(user.id, user.email);

    await this.updateRtHash(user.id, tokens.refreshToken);

    return {
      user: this.buildUserResponse(user),
      tokens,
    } as AuthResponseDto;
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
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

    const tokens = await this.getTokens(user.id, user.email);

    await this.updateRtHash(user.id, tokens.refreshToken);

    return {
      user: this.buildUserResponse(user),
      tokens,
    } as AuthResponseDto;
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedRt: null },
    });

    return { message: 'Logged out successfully' };
  }

  private async getTokens(userId: string, email: string) {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { id: userId, email },
        {
          secret: this.config.getOrThrow<string>('JWT_SECRET') as StringValue,
          expiresIn: this.config.getOrThrow<string>(
            'JWT_EXPIRES_IN',
          ) as StringValue,
        },
      ),
      this.jwtService.signAsync(
        { id: userId, email },
        {
          secret: this.config.getOrThrow<string>(
            'JWT_REFRESH_SECRET',
          ) as StringValue,
          expiresIn: this.config.getOrThrow<string>(
            'JWT_REFRESH_EXPIRES_IN',
          ) as StringValue,
        },
      ),
    ]);

    return {
      accessToken: accessToken,
      refreshToken: refreshToken,
    };
  }

  private buildUserResponse(user: { id: string; email: string; name: string; role: string; }): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      fullName: user.name,
      role: user.role,
    };
  }

  // bcrypt only uses the first 72 bytes, which are identical for every JWT of
  // the same user, so refresh tokens are hashed with SHA-256 instead.
  private hashRefreshToken(refreshToken: string) {
    return createHash('sha256').update(refreshToken).digest('hex');
  }

  private refreshTokenMatches(refreshToken: string, storedHash: string) {
    const candidate = Buffer.from(this.hashRefreshToken(refreshToken));
    const stored = Buffer.from(storedHash);
    return (
      candidate.length === stored.length && timingSafeEqual(candidate, stored)
    );
  }

  private async updateRtHash(userId: string, refreshToken: string) {
    const hash = this.hashRefreshToken(refreshToken);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        hashedRt: hash,
      },
    });
  }
}
