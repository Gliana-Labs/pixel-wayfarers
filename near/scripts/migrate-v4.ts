/**
 * v4 migration, once: the collection's own key calls `migrate_inventory` for every token (item URLs -> item records,
 * common, kind unknown). Usage: npx tsx scripts/migrate-v4.ts   (COLLECTION defaults to pixelwayfarers.testnet; key from ~/.near-gliana)
 */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const COLLECTION = process.env.COLLECTION ?? 'pixelwayfarers.testnet';
const key = JSON.parse(readFileSync(`${homedir()}/.near-gliana/${COLLECTION}.json`, 'utf8')).private_key;
const p = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' });
const acct = new Account(COLLECTION, p, new KeyPairSigner(KeyPair.fromString(key)));
const tokens = (await p.callFunction(COLLECTION, 'nft_tokens', { limit: 100 })) as { token_id: string }[];
const ids = tokens.map((t) => t.token_id);
for (let i = 0; i < ids.length; i += 20) {
  await acct.callFunction({ contractId: COLLECTION, methodName: 'migrate_inventory', args: { token_ids: ids.slice(i, i + 20) }, gas: 300_000_000_000_000n });
  await new Promise((r) => setTimeout(r, 3000));
}
const recs = await Promise.all(ids.map(async (id) => ((await p.callFunction(COLLECTION, 'inventory', { token_id: id })) as unknown[]).length));
console.log(`migrated ${ids.length} tokens; ${recs.reduce((a, b) => a + b, 0)} item records`);
