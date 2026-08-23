import type { FastifyRequest } from 'fastify';

/**
 * The caller's IP, for rate limiting.
 *
 * WHY THIS IS ONE FUNCTION AND NOT A `request.ip` AT EVERY CALL SITE
 * ------------------------------------------------------------------
 * Every rate limit in the product keys on this, and each route having its own
 * idea of what "the client" means is how one endpoint ends up limiting the load
 * balancer instead of the user.
 *
 * CF-CONNECTING-IP IS PREFERRED OVER X-FORWARDED-FOR
 * --------------------------------------------------
 * Cloudflare sets `cf-connecting-ip` to the real client and OVERWRITES any
 * value the client sent. `x-forwarded-for` is a list that Cloudflare appends
 * to — so its leftmost entry is whatever the client claimed, and parsing it
 * naively hands an attacker a free rotating IP.
 *
 * Both are only meaningful when the origin is locked to Cloudflare, which is
 * what `TRUST_PROXY` asserts. When it is false, Fastify has already ignored
 * every forwarding header and `request.ip` is the socket's own address — the
 * only thing that cannot be forged.
 */
export function clientIp(request: FastifyRequest, trustProxy: boolean): string {
  // When the proxy is not trusted, Fastify has already ignored the forwarding
  // headers — and so must this. Reading them anyway would reintroduce exactly
  // the spoofing the setting exists to prevent.
  if (!trustProxy) return request.ip;

  const cloudflare = request.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare.length > 0) return cloudflare;

  // Fastify has already resolved x-forwarded-for correctly given trustProxy.
  return request.ip;
}
