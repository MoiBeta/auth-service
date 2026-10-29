import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Protects service-to-service endpoints. Callers must send the shared
 * INTERNAL_API_KEY in the `x-internal-api-key` header.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.getOrThrow<string>('INTERNAL_API_KEY');
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-api-key'];

    if (typeof provided !== 'string') {
      throw new UnauthorizedException();
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
