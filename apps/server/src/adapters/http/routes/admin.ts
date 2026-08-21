import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import type { QueuedReport } from '../../../app/index.js';
import { asReportId, asUserId } from '../../../domain/values/ids.js';
import { AuthorizationError } from '../../../domain/errors.js';

/**
 * The admin surface: moderation queue, review, ban.
 *
 * WHY IT IS SERVER-RENDERED HTML
 * ------------------------------
 * The spec allows it, and it is the right call for three reasons that outlast
 * the convenience:
 *
 *   1. It has NO dependency on the PWA. When the thing a moderator needs to
 *      look at is a bug in the app, the tool for looking at it should not be
 *      the app.
 *   2. It cannot leak into the public bundle. A React admin screen shares a
 *      build with the user-facing client, and one careless import later a
 *      moderation helper is shipped to everyone.
 *   3. It is one file. A moderation tool that is expensive to change is a
 *      moderation tool that stops matching the policy it enforces.
 *
 * AUTHENTICATION IS TWO INDEPENDENT FACTS
 * ---------------------------------------
 *   - a shared ADMIN_TOKEN, which gates the surface entirely, and
 *   - a moderator user id from the config allowlist, which gates the ACTIONS.
 *
 * Neither alone is sufficient. The token stops a curious logged-in user from
 * finding the page; the allowlist means every action is attributable to a
 * named person, so "who banned this account" always has an answer.
 */

const queueQuery = z.object({
  status: z.enum(['open', 'reviewing', 'upheld', 'dismissed']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const resolveBody = z.object({
  reportId: z.string().uuid(),
  outcome: z.enum(['upheld', 'dismissed']),
  resolution: z.string().min(1).max(2000),
  /** Ban the target as well. Null hours means permanent. */
  ban: z.boolean().optional(),
  banHours: z.number().int().positive().nullable().optional(),
});

const banBody = z.object({
  userId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  hours: z.number().int().positive().nullable(),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { config, ports, useCases } = deps;

  /**
   * Gate the whole surface on the shared token.
   *
   * Compared in constant time. The timing channel on a shared secret is a
   * stretch, but the pattern is copied, and the next place it is copied to may
   * matter more.
   */
  const requireAdminToken = (request: FastifyRequest): void => {
    const provided =
      (request.headers['x-admin-token'] as string | undefined) ??
      (request.query as { token?: string }).token ??
      '';

    if (!timingSafeEqualString(provided, config.ADMIN_TOKEN)) {
      throw new AuthorizationError('Admin access required.', 'FORBIDDEN');
    }
  };

  /**
   * The acting moderator.
   *
   * Named explicitly rather than inferred from a session, because the admin
   * page is reached with a shared token — so the ONE thing that makes an
   * action attributable is this header, and it is checked against the config
   * allowlist by every use case downstream.
   */
  const actingModerator = (request: FastifyRequest) => {
    const id = request.headers['x-moderator-id'] as string | undefined;
    if (id === undefined || id.length === 0) {
      throw new AuthorizationError(
        'Send X-Moderator-Id so this action is attributable.',
        'FORBIDDEN',
      );
    }
    return asUserId(id);
  };

  // -- JSON API -------------------------------------------------------------

  app.get('/admin/queue', async (request, reply) => {
    requireAdminToken(request);
    const query = queueQuery.parse(request.query);

    const queue = await useCases.listReportQueue.execute(actingModerator(request), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });

    return reply.send({ reports: queue.map(serializeQueued) });
  });

  app.post('/admin/reports/resolve', async (request, reply) => {
    requireAdminToken(request);
    const body = resolveBody.parse(request.body);
    const moderatorId = actingModerator(request);

    const report = await useCases.resolveReport.execute(moderatorId, {
      reportId: asReportId(body.reportId),
      outcome: body.outcome,
      resolution: body.resolution,
    });

    // Resolving and banning are separate decisions — see ResolveReport for why
    // — but a moderator upholding a serious report usually wants both, so the
    // endpoint accepts them together while the use cases stay distinct.
    if (body.ban === true) {
      await useCases.banUser.execute(moderatorId, {
        targetId: report.targetId,
        reason: body.resolution,
        hours: body.banHours ?? null,
        context: report.id,
      });
    }

    return reply.send({ ok: true, status: report.status, banned: body.ban === true });
  });

  app.post('/admin/ban', async (request, reply) => {
    requireAdminToken(request);
    const body = banBody.parse(request.body);

    await useCases.banUser.execute(actingModerator(request), {
      targetId: asUserId(body.userId),
      reason: body.reason,
      hours: body.hours,
    });

    return reply.send({ ok: true });
  });

  app.post('/admin/unban', async (request, reply) => {
    requireAdminToken(request);
    const body = z.object({ userId: z.string().uuid() }).parse(request.body);

    await useCases.liftBan.execute(actingModerator(request), asUserId(body.userId));
    return reply.send({ ok: true });
  });

  /** Live counters for the dashboard. */
  app.get('/admin/metrics', async (request, reply) => {
    requireAdminToken(request);

    const [totals, openReports, reviewing] = await Promise.all([
      ports.metrics.snapshot(),
      ports.reports.countByStatus('open'),
      ports.reports.countByStatus('reviewing'),
    ]);

    return reply.send({ totals, openReports, reviewing });
  });

  // -- the page -------------------------------------------------------------

  app.get('/admin', async (request, reply) => {
    requireAdminToken(request);

    const moderatorId = (request.headers['x-moderator-id'] as string | undefined) ?? '';
    const token = (request.query as { token?: string }).token ?? '';

    let queue: readonly QueuedReport[] = [];
    let queueError: string | null = null;

    try {
      queue =
        moderatorId.length > 0
          ? await useCases.listReportQueue.execute(asUserId(moderatorId), { status: 'open' })
          : [];
    } catch (error) {
      queueError = error instanceof Error ? error.message : 'Could not load the queue.';
    }

    const openCount = await ports.reports.countByStatus('open');
    const reviewingCount = await ports.reports.countByStatus('reviewing');

    return (
      reply
        .type('text/html; charset=utf-8')
        // The page contains report text written by users. `default-src 'none'`
        // plus an inline-style allowance means even a stored-XSS attempt in a
        // report note has nothing to execute with.
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
        .header('referrer-policy', 'no-referrer')
        .send(renderAdminPage({ queue, queueError, openCount, reviewingCount, token, moderatorId }))
    );
  });
}

// ---------------------------------------------------------------------------

function serializeQueued(entry: QueuedReport) {
  return {
    id: entry.report.id,
    category: entry.report.category,
    note: entry.report.note,
    status: entry.report.status,
    createdAt: entry.report.createdAt.toISOString(),
    roomId: entry.report.roomId,
    target: {
      id: entry.report.targetId,
      displayName: entry.targetDisplayName,
      trustScore: entry.targetTrustScore,
      status: entry.targetStatus,
      priorReports: entry.targetHistory.length,
    },
    reporter: { id: entry.report.reporterId, displayName: entry.reporterDisplayName },
  };
}

/**
 * Escape everything that reaches the page.
 *
 * Report notes are USER-WRITTEN TEXT, and the person writing one is often
 * hostile. This is the only defence between that and a moderator's browser,
 * so it is applied to every interpolation without exception — including
 * display names, which are equally user-controlled.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface AdminPageModel {
  readonly queue: readonly QueuedReport[];
  readonly queueError: string | null;
  readonly openCount: number;
  readonly reviewingCount: number;
  readonly token: string;
  readonly moderatorId: string;
}

function renderAdminPage(model: AdminPageModel): string {
  const rows =
    model.queue.length === 0
      ? `<tr><td colspan="6" class="empty">Nothing waiting. </td></tr>`
      : model.queue.map(renderRow).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loverlink moderation</title>
<style>
  :root { color-scheme: dark; }
  body { background:#100a18; color:#f4eefb; font:14px/1.5 system-ui,sans-serif; margin:0; padding:1.5rem; }
  h1 { font-size:1.1rem; letter-spacing:.14em; text-transform:uppercase; color:#d98cae; margin:0 0 .25rem; }
  .counts { color:#a996bd; margin-bottom:1.5rem; }
  .count { display:inline-block; margin-right:1.25rem; }
  .count b { color:#f4eefb; font-size:1.3rem; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:.7rem; letter-spacing:.1em; text-transform:uppercase; color:#6f5f83; border-bottom:1px solid #2f2140; padding:.5rem .6rem; }
  td { border-bottom:1px solid #2f2140; padding:.7rem .6rem; vertical-align:top; }
  .urgent { color:#e06b7f; font-weight:600; }
  .note { color:#a996bd; max-width:26rem; overflow-wrap:anywhere; }
  .meta { color:#6f5f83; font-size:.78rem; }
  .warn { color:#e06b7f; }
  .empty { color:#6f5f83; text-align:center; padding:2.5rem; }
  form { display:flex; flex-direction:column; gap:.35rem; }
  input, select, button { background:#201530; border:1px solid #2f2140; color:#f4eefb; border-radius:8px; padding:.4rem .5rem; font:inherit; }
  button { background:#c4527d; border:none; cursor:pointer; }
  .banner { background:rgba(224,107,127,.12); border:1px solid rgba(224,107,127,.35); color:#e06b7f; padding:.7rem .9rem; border-radius:10px; margin-bottom:1.25rem; }
</style>
</head>
<body>
  <h1>Loverlink moderation</h1>
  <p class="counts">
    <span class="count"><b>${model.openCount}</b> open</span>
    <span class="count"><b>${model.reviewingCount}</b> in review</span>
  </p>

  ${
    model.moderatorId.length === 0
      ? `<p class="banner">Send an <code>X-Moderator-Id</code> header to load the queue. Every
         action is attributed to it, so "who banned this account" always has an answer.</p>`
      : ''
  }
  ${model.queueError === null ? '' : `<p class="banner">${escapeHtml(model.queueError)}</p>`}

  <table>
    <thead>
      <tr>
        <th>Reported</th><th>Category</th><th>What they said</th>
        <th>Standing</th><th>By</th><th>Decide</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function renderRow(entry: QueuedReport): string {
  const urgent = entry.report.category === 'minor_safety' || entry.report.category === 'self_harm';

  return `      <tr>
        <td>
          ${escapeHtml(entry.targetDisplayName)}<br>
          <span class="meta">${escapeHtml(entry.report.targetId)}</span>
        </td>
        <td class="${urgent ? 'urgent' : ''}">${escapeHtml(entry.report.category)}</td>
        <td class="note">${escapeHtml(entry.report.note) || '<span class="meta">(no note)</span>'}</td>
        <td>
          trust ${entry.targetTrustScore}<br>
          <span class="${entry.targetHistory.length > 1 ? 'warn' : 'meta'}">
            ${entry.targetHistory.length} report(s) total
          </span><br>
          <span class="meta">${escapeHtml(entry.targetStatus)}</span>
        </td>
        <td>
          ${escapeHtml(entry.reporterDisplayName)}<br>
          <span class="meta">${escapeHtml(entry.report.createdAt.toISOString())}</span>
        </td>
        <td>
          <form method="post" action="/admin/reports/resolve">
            <input type="hidden" name="reportId" value="${escapeHtml(entry.report.id)}">
            <select name="outcome">
              <option value="upheld">Uphold</option>
              <option value="dismissed">Dismiss</option>
            </select>
            <input name="resolution" placeholder="Why?" required>
            <select name="banHours">
              <option value="">No ban</option>
              <option value="24">Suspend 24h</option>
              <option value="72">Suspend 72h</option>
              <option value="permanent">Ban permanently</option>
            </select>
            <button type="submit">Apply</button>
          </form>
        </td>
      </tr>`;
}

/**
 * Constant-time string comparison.
 *
 * Length is compared first and returns early, which does leak the length of
 * the expected token — acceptable, since the length of a shared admin secret
 * is not the part that needs protecting.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
