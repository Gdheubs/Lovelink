import { loadConfig } from '../src/config.js';
import { createContainer } from '../src/container.js';
import { createUseCases } from '../src/app/index.js';
import { createLogger } from '../src/adapters/observability/PinoLogger.js';
import { asUserId } from '../src/domain/values/ids.js';

/**
 * Send one real push through the configured adapter and report what happened.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other test in this repo stops at the port. The one thing they cannot
 * cover is whether `web-push` is wired to real VAPID keys correctly and whether
 * this deployment can actually reach a push service — which is exactly the
 * class of failure that only appears after deploying.
 *
 * It is also the only practical way to exercise the EXPIRY path on demand: a
 * made-up endpoint on a real push service answers 404, which is precisely the
 * signal the adapter must translate into "delete this row".
 *
 * Usage:
 *   VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com \
 *     npx tsx scripts/pushProbe.ts <userId>
 */
async function main(): Promise<void> {
  const userId = process.argv[2];
  if (userId === undefined) {
    throw new Error('Pass a user id: npx tsx scripts/pushProbe.ts <userId>');
  }

  const config = loadConfig();
  const logger = createLogger({ level: 'debug', pretty: false, name: 'push-probe' });
  const container = await createContainer({ config, logger });
  const { ports } = container;

  const useCases = createUseCases(ports, {
    echoLoginCode: config.AUTH_ECHO_CODE,
    moderatorUserIds: [],
  });

  const before = await ports.pushSubscriptions.listForUser(asUserId(userId));
  process.stdout.write(`configured:    ${ports.push.publicKey() !== null}\n`);
  process.stdout.write(`subscriptions: ${before.length}\n`);

  await useCases.sendPush.execute(asUserId(userId), {
    title: 'Loverlink',
    body: 'is calling you',
    url: '/connections',
    tag: 'probe',
    urgent: true,
  });

  const after = await ports.pushSubscriptions.listForUser(asUserId(userId));
  process.stdout.write(`after:         ${after.length}\n`);
  process.stdout.write(
    before.length > after.length
      ? 'RESULT: the push service rejected the endpoint and the dead row was removed\n'
      : 'RESULT: the endpoint was accepted (or the failure was transient and kept)\n',
  );

  await container.shutdown();
}

main().catch((error: unknown) => {
  process.stderr.write(`push probe failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
