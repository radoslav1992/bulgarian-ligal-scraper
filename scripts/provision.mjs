/**
 * Idempotent provisioning of the Cloudflare resources this worker binds to.
 * Runs in CI before `wrangler deploy` (needs CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID in the environment); safe to run repeatedly and
 * also works locally after `wrangler login`.
 *
 *  - Vectorize index + metadata indexes (source, docId)
 *  - D1 database, with the resolved database_id patched into wrangler.jsonc
 *  - D1 migrations
 *  - Crawl queue + dead letter queue
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const VECTORIZE_INDEX = 'bg-legal-index';
const D1_NAME = 'bg-legal-registry';
const QUEUES = ['bg-legal-crawl', 'bg-legal-crawl-dlq'];
const CONFIG_PATH = new URL('../wrangler.jsonc', import.meta.url);

function wrangler(...args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run a create command, tolerating "already exists"-style failures. */
function ensure(...args) {
  try {
    console.log(`+ wrangler ${args.join(' ')}`);
    wrangler(...args);
  } catch (err) {
    const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    if (/already.?exist|duplicate|in use/i.test(out)) {
      console.log(`  already exists, ok`);
    } else {
      console.error(out);
      throw err;
    }
  }
}

// --- Vectorize ---------------------------------------------------------
ensure('vectorize', 'create', VECTORIZE_INDEX, '--dimensions=1024', '--metric=cosine');
ensure('vectorize', 'create-metadata-index', VECTORIZE_INDEX, '--property-name=source', '--type=string');
ensure('vectorize', 'create-metadata-index', VECTORIZE_INDEX, '--property-name=docId', '--type=string');

// --- Queues ------------------------------------------------------------
for (const queue of QUEUES) {
  ensure('queues', 'create', queue);
}

// --- D1 ----------------------------------------------------------------
ensure('d1', 'create', D1_NAME);

const databases = JSON.parse(wrangler('d1', 'list', '--json'));
const db = databases.find((d) => d.name === D1_NAME);
if (!db?.uuid) {
  throw new Error(`D1 database "${D1_NAME}" not found after creation`);
}
console.log(`D1 "${D1_NAME}" id: ${db.uuid}`);

const config = readFileSync(CONFIG_PATH, 'utf8');
const patched = config.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${db.uuid}"`);
if (patched !== config) {
  writeFileSync(CONFIG_PATH, patched);
  console.log('Patched database_id into wrangler.jsonc');
}

console.log(`+ wrangler d1 migrations apply ${D1_NAME} --remote`);
console.log(wrangler('d1', 'migrations', 'apply', D1_NAME, '--remote'));

console.log('Provisioning complete.');
