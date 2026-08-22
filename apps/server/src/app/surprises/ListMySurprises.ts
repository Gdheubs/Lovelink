import type { Surprise } from '../../domain/entities/Surprise.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import { formatCode } from '../../domain/entities/Surprise.js';

/**
 * USE CASE: the surprises this person has sent and received.
 *
 * WHY THIS EXISTS RATHER THAN THE ROUTE CALLING THE REPOSITORY
 * ------------------------------------------------------------
 * Reading your own rows needs no authorization beyond the query itself, so it
 * is tempting to let the HTTP edge reach straight into the port. The reason not
 * to is that the two views below are a POLICY decision — what a sender is
 * allowed to learn about a surprise once someone else has opened it — and
 * policy that lives in a route file is policy that exists once per edge.
 *
 * THE TWO VIEWS ARE DELIBERATELY DIFFERENT
 * ----------------------------------------
 * SENT keeps the code, because a sender may need to read it out again, and
 * keeps the message, because they wrote it. It does NOT include the recipient's
 * chosen mood: that was a private disclosure made in order to select a message,
 * not a message to the sender. "They opened it and they were sad" is not
 * something the recipient agreed to share.
 *
 * RECEIVED drops the code entirely. It has already done its job, and repeating
 * a live claim code inside a second person's history is a way for it to be read
 * off a shared screen by someone it was never meant for.
 */
export interface SentSurpriseView {
  readonly id: string;
  readonly code: string;
  readonly theme: Surprise['theme'];
  readonly message: string;
  readonly opened: boolean;
  readonly openedAt: string | null;
  readonly expiresAt: string;
}

export interface ReceivedSurpriseView {
  readonly id: string;
  readonly theme: Surprise['theme'];
  readonly message: string;
  readonly mood: Surprise['moodSelected'];
  readonly tasks: readonly { text: string; done: boolean }[];
  readonly openedAt: string | null;
}

export interface MySurprisesView {
  readonly sent: readonly SentSurpriseView[];
  readonly received: readonly ReceivedSurpriseView[];
}

/** Enough to fill the screen and scroll a little; not an archive. */
const PAGE = 50;

export class ListMySurprises {
  constructor(private readonly ports: Ports) {}

  async execute(viewer: User): Promise<MySurprisesView> {
    const [sent, received] = await Promise.all([
      this.ports.surprises.listSentBy(viewer.id, PAGE),
      this.ports.surprises.listReceivedBy(viewer.id, PAGE),
    ]);

    return {
      sent: sent.map((surprise) => ({
        id: surprise.id,
        code: formatCode(surprise.code),
        theme: surprise.theme,
        message: surprise.message,
        opened: surprise.openedAt !== null,
        openedAt: surprise.openedAt?.toISOString() ?? null,
        expiresAt: surprise.expiresAt.toISOString(),
      })),
      received: received.map((surprise) => ({
        id: surprise.id,
        theme: surprise.theme,
        message: surprise.message,
        mood: surprise.moodSelected,
        tasks: surprise.tasks.map((task) => ({ text: task.text, done: task.done })),
        openedAt: surprise.openedAt?.toISOString() ?? null,
      })),
    };
  }
}
