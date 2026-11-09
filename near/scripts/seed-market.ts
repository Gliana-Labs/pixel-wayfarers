/**
 * Demo seed for the item market (testnet): a test account gifts some of Alice's Wayfarers new hobby items (each rolls
 * its own rarity on chain), the studio paints them, then Alice lists a few. npx tsx scripts/seed-market.ts
 */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { FailoverRpcProvider, JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const COLLECTION = 'pixelwayfarers.testnet';
const ALICE = 'wayfarers-alice-mw8aebcv.testnet';
const CAROL = 'wayfarers-carol-mw8aej2a.testnet';
const NEAR = 10n ** 24n;
const p = new FailoverRpcProvider(['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'].map((url) => new JsonRpcProvider({ url })));
const acct = (id: string) => new Account(id, p, new KeyPairSigner(KeyPair.fromString(JSON.parse(readFileSync(`${homedir()}/.near-gliana/${id}.json`, 'utf8')).private_key)));
const [alice, carol] = [acct(ALICE), acct(CAROL)];
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

const mine = ((await view('nft_tokens_for_owner', { account_id: ALICE, limit: 50 })) as { token_id: string }[]).map((t) => t.token_id);
const targets = mine.filter((t) => t !== '42').slice(0, 4);
const kinds = [33, 22, 31, 12, 0, 24, 16, 9]; // microphone, hamster, cupcake, bicycle, guitar, soccer ball, telescope, cat
const orders: string[] = [];
for (let i = 0; i < kinds.length; i++) {
  const t = targets[i % targets.length];
  await retry(() => carol.callFunction({ contractId: COLLECTION, methodName: 'commission', args: { token_id: t, item: kinds[i] }, deposit: NEAR / 5n, gas: 30_000_000_000_000n }));
  await sleep(2500);
}
for (let round = 0; round < 12; round++) {
  const left = ((await view('pending', {})) as any[]).filter((c) => c.buyer === CAROL).length;
  console.log(`waiting for the studio: ${left} left`);
  if (!left) break;
  await fetch('https://pixelwayfarers.com/api/near/deliver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  await sleep(20000);
}
const prices = [NEAR / 20n, NEAR / 10n, (NEAR * 3n) / 20n, NEAR / 4n, NEAR / 2n];
let n = 0;
for (const t of targets) {
  const inv = (await view('inventory', { token_id: t })) as any[];
  for (const it of inv.filter((i) => i.kind !== 255 && !i.price).slice(0, 2)) {
    if (n >= prices.length) break;
    const price = (prices[n] * BigInt(1 + it.tier)).toString();
    await retry(() => alice.callFunction({ contractId: COLLECTION, methodName: 'list_item', args: { token_id: t, item_id: it.id, price }, deposit: 1n, gas: 30_000_000_000_000n }));
    console.log(`listed #${t}'s item ${it.id} (kind ${it.kind}, tier ${it.tier}) for ${Number(BigInt(price) / 10n ** 21n) / 1000} NEAR`);
    n++;
    await sleep(2500);
  }
}
