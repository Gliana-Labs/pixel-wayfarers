/**
 * Give the studio worker a key that may only call `fulfil` on the collection, and nothing else: it can't move the
 * studio's NEAR, add keys or call other methods. Saved owner-only to ~/.near-gliana/<studio>-fulfil-<collection>.json; with
 * ENV_FILE=path it also writes STUDIO_FULFIL_KEY=... there (0600) for `wrangler dev --env-file` or `wrangler secret put`.
 * The key is never printed.
 *
 *   NETWORK=testnet COLLECTION=pixelwayfarers.testnet STUDIO=wayfarers-studio.testnet npx tsx scripts/studio-key.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';

const NETWORK = process.env.NETWORK ?? 'testnet';
const COLLECTION = process.env.COLLECTION ?? 'pixelwayfarers.testnet';
const STUDIO = process.env.STUDIO ?? 'wayfarers-studio.testnet';
const p = new JsonRpcProvider({ url: NETWORK === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://test.rpc.fastnear.com' });
// One key per collection: a function-call key names exactly one receiver.
const out = join(homedir(), '.near-gliana', `${STUDIO}-fulfil-${COLLECTION}.json`);
let key: string;
if (existsSync(out)) key = JSON.parse(readFileSync(out, 'utf8')).private_key;
else {
  const full = JSON.parse(readFileSync(join(homedir(), '.near-gliana', `${STUDIO}.json`), 'utf8'));
  const kp = KeyPair.fromRandom('ed25519');
  writeFileSync(out, JSON.stringify({ account_id: STUDIO, public_key: kp.getPublicKey().toString(), private_key: kp.toString(), may_call: `${COLLECTION}.fulfil` }), { mode: 0o600 });
  const studio = new Account(STUDIO, p, new KeyPairSigner(KeyPair.fromString(full.private_key)));
  await studio.signAndSendTransaction({ receiverId: STUDIO, actions: [actionCreators.addKey(kp.getPublicKey(), actionCreators.functionCallAccessKey(COLLECTION, ['fulfil'], 10n ** 24n))] });
  key = kp.toString();
  console.log(`added a fulfil-only key to ${STUDIO} (saved to ${out})`);
}
if (process.env.ENV_FILE) writeFileSync(process.env.ENV_FILE, `STUDIO_FULFIL_KEY=${key}\n`, { mode: 0o600 });
const keys = (await p.query({ request_type: 'view_access_key_list', finality: 'final', account_id: STUDIO })) as any;
console.log('studio keys:', JSON.stringify(keys.keys.map((k: any) => (typeof k.access_key.permission === 'string' ? k.access_key.permission : { receiver: k.access_key.permission.FunctionCall.receiver_id, methods: k.access_key.permission.FunctionCall.method_names }))));
