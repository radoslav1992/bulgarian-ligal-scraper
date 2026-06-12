import { handleRequest } from './api';
import { sleep } from './lib/fetch';
import { handleDiscover, handleDoc, kickOff, logEvent } from './pipeline';
import type { CrawlJob, Env } from './types';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env);
  },

  /** Daily incremental run: re-list everything, re-index only changed documents. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(kickOff(env, 'incremental'));
  },

  async queue(batch: MessageBatch<CrawlJob>, env: Env): Promise<void> {
    const delayMs = Number(env.CRAWL_DELAY_MS ?? '500') || 500;

    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === 'discover') {
          await handleDiscover(env, job);
        } else {
          await handleDoc(env, job);
        }
        message.ack();
      } catch (err) {
        console.error(`Job failed (${job.type}, ${job.source}):`, err);
        try {
          await logEvent(
            env,
            job.source,
            'error',
            `${job.type} ${'cursor' in job ? job.cursor : job.url}: ${String(err).slice(0, 500)}`,
          );
        } catch {
          // Logging must never mask the original failure.
        }
        message.retry({ delaySeconds: 60 });
      }
      // Pace requests towards the source sites.
      await sleep(delayMs);
    }
  },
} satisfies ExportedHandler<Env, CrawlJob>;
