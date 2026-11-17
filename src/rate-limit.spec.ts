import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RefreshTokenGuard } from './auth/guards/refresh-token.guard';
import { RATE_LIMITS, TRUSTED_PROXIES, throttlerOptions } from './rate-limit';
import { InternalApiKeyGuard } from './users/guards/internal-api-key.guard';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

describe('Rate limiting', () => {
  let app: NestExpressApplication;

  const allow = { canActivate: () => true };
  const credentials = { email: 'user@example.com', password: 'secret' };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerOptions)],
      controllers: [AppController, AuthController, UsersController],
      providers: [
        AppService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        {
          provide: AuthService,
          useValue: {
            login: jest.fn().mockResolvedValue({ ok: true }),
            register: jest.fn().mockResolvedValue({ ok: true }),
          },
        },
        {
          provide: UsersService,
          useValue: { findById: jest.fn().mockResolvedValue({ id: '1' }) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(RefreshTokenGuard)
      .useValue(allow)
      .overrideGuard(InternalApiKeyGuard)
      .useValue(allow)
      .compile();

    app = module.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', TRUSTED_PROXIES);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const login = (ip?: string) => {
    const req = request(app.getHttpServer()).post('/auth/login');
    if (ip) req.set('X-Forwarded-For', ip);
    return req.send(credentials);
  };

  it('blocks login attempts over the limit', async () => {
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      expect((await login()).status).toBe(200);
    }

    const blocked = await login();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('blocks registrations over the limit', async () => {
    const register = () =>
      request(app.getHttpServer()).post('/auth/register').send({});

    for (let i = 0; i < RATE_LIMITS.register.limit; i++) {
      expect((await register()).status).toBe(201);
    }
    expect((await register()).status).toBe(429);
  });

  it('keeps a separate budget for each endpoint', async () => {
    for (let i = 0; i <= RATE_LIMITS.login.limit; i++) {
      await login();
    }

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({});
    expect(res.status).toBe(201);
  });

  it('counts each client behind the proxy separately', async () => {
    for (let i = 0; i <= RATE_LIMITS.login.limit; i++) {
      await login('203.0.113.10');
    }

    expect((await login('203.0.113.10')).status).toBe(429);
    expect((await login('203.0.113.20')).status).toBe(200);
  });

  it('does not limit the service-to-service endpoint', async () => {
    const calls = RATE_LIMITS.default.limit + 5;
    for (let i = 0; i < calls; i++) {
      const res = await request(app.getHttpServer()).get('/users/1');
      expect(res.status).toBe(200);
    }
  });

  it('does not limit the health check', async () => {
    const calls = RATE_LIMITS.default.limit + 5;
    for (let i = 0; i < calls; i++) {
      const res = await request(app.getHttpServer()).get('/');
      expect(res.status).toBe(200);
    }
  });
});
