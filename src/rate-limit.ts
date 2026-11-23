import { ThrottlerModuleOptions, minutes } from '@nestjs/throttler';

/**
 * Requests allowed per client IP in each time window.
 *
 * The credential endpoints are the ones worth attacking, so they get a much
 * smaller budget than the rest of the API.
 */
export const RATE_LIMITS = {
  default: { limit: 120, ttl: minutes(1) },
  login: { limit: 10, ttl: minutes(1) },
  register: { limit: 5, ttl: minutes(1) },
  refresh: { limit: 30, ttl: minutes(1) },
  emailCode: { limit: 10, ttl: minutes(1) },
} as const;

export const throttlerOptions: ThrottlerModuleOptions = {
  throttlers: [{ name: 'default', ...RATE_LIMITS.default }],
};

/**
 * The service sits behind a reverse proxy, so the client IP comes in the
 * X-Forwarded-For header. It is only trusted when the direct peer is on a
 * private network (the proxy); a client connecting directly cannot use the
 * header to pose as another IP and dodge the limits.
 */
export const TRUSTED_PROXIES = ['loopback', 'uniquelocal'];
