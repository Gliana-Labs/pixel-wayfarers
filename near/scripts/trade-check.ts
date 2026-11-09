/**
 * v4 check on testnet: one of Alice's Wayfarers lists an item, another of hers buys it with its own money.
 * npx tsx scripts/trade-check.ts. Retries the RPC's own failures (stale block hash, 429), not contract errors.
 */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { FailoverRpcProvider, JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const COLLECTION = process.env.COLLECTION ?? 'pixelwayfarers.testnet';
const ALICE = 'wayfarers-alice-mw8aebcv.testnet';
const p = new FailoverRpcProvider(['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'].map((url) => new JsonRpcProvider({ url })));
const alice = new Account(ALICE, p, new KeyPairSigner(KeyPair.fromString(JSON.parse(readFileSync(`${homedir()}/.near-gliana/${ALICE}.json`, 'utf8')).private_key)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 4 || !/expired|429|Internal server|timeout|Exceeded/i.test(String(e))) throw e;
      await sleep(3000);
    }
  }
}
const view = (m: string, a: object) => retry(() => p.callFunction(COLLECTION, m, a)) as Promise<any>;
const near = async (id: string) => Number(BigInt((await retry(() => p.viewAccount(id))).amount) / 10n ** 18n) / 1e6;

const mine = ((await view('nft_tokens_for_owner', { account_id: ALICE, limit: 50 })) as { token_id: string }[]).map((t) => t.token_id);
const withItems: string[] = [];
for (const t of mine) if (((await view('inventory', { token_id: t })) as unknown[]).length) withItems.push(t);
const seller = withItems.find((t) => t !== '42')!;
const buyer = '42';
const item = (await view('inventory', { token_id: seller }))[0];
console.log(`seller #${seller} item #${item.id} (tier ${item.tier}), buyer #${buyer}`);
const price = (10n ** 22n).toString(); // 0.01 NEAR
await retry(() => alice.callFunction({ contractId: COLLECTION, methodName: 'list_item', args: { token_id: seller, item_id: item.id, price }, deposit: 1n, gas: 30_000_000_000_000n }));
await sleep(2500);
const before = await near(`${seller}.${COLLECTION}`);
await retry(() => alice.callFunction({ contractId: COLLECTION, methodName: 'buy_listed_item', args: { buyer_token: buyer, seller_token: seller, item_id: item.id, price }, deposit: 1n, gas: 60_000_000_000_000n }));
await sleep(3500);
const moved = ((await view('inventory', { token_id: buyer })) as any[]).some((i) => i.id === item.id && i.painted_for === seller);
const after = await near(`${seller}.${COLLECTION}`);
console.log(`${moved && after - before > 0.0099 ? 'PASS' : 'FAIL'}  item #${item.id} moved #${seller} -> #${buyer}: ${moved}; #${seller}'s account ${before} -> ${after} NEAR`);
