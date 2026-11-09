/**
 * v3 migration, once: the collection's own key calls `drop_scenes` for every token, so inventories hold only items.
 * Usage: npx tsx scripts/migrate-v3.ts   (COLLECTION defaults to pixelwayfarers.testnet; key from ~/.near-gliana)
 */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { FailoverRpcProvider, JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const COLLECTION = process.env.COLLECTION ?? 'pixelwayfarers.testnet';
const key = JSON.parse(readFileSync(`${homedir()}/.near-gliana/${COLLECTION}.json`, 'utf8')).private_key;
// rpc.testnet.near.org is deprecated (429s since 2026-11-10).
const p = new FailoverRpcProvider(['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'].map((url) => new JsonRpcProvider({ url })));
const acct = new Account(COLLECTION, p, new KeyPairSigner(KeyPair.fromString(key)));
const tokens = (await p.callFunction(COLLECTION, 'nft_tokens', { limit: 100 })) as { token_id: string }[];
const ids = tokens.map((t) => t.token_id);
for (let i = 0; i < ids.length; i += 20) {
  await acct.callFunction({ contractId: COLLECTION, methodName: 'drop_scenes', args: { token_ids: ids.slice(i, i + 20) }, gas: 300_000_000_000_000n });
  await new Promise((r) => setTimeout(r, 3000));
}
const left = await Promise.all(ids.map(async (id) => ((await p.callFunction(COLLECTION, 'items', { token_id: id })) as string[]).filter((u) => u.includes('/scenes/')).length));
console.log(`checked ${ids.length} tokens; scene pictures left: ${left.reduce((a, b) => a + b, 0)}`);
