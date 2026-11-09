/**
 * Testnet, end to end, with real transactions: publish the purse as a global contract (by code hash), deploy the
 * collection, mint, commission, deliver, withdraw from the token's own account, sell, and check the seller is locked
 * out while the buyer can withdraw. Accounts come from the public testnet faucet; keys go to ~/.near-gliana (0600).
 *
 *   npm run build && npm run e2e:testnet
 *
 * Re-running reuses the accounts it made and skips what's already deployed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators, GlobalContractDeployMode } from '@near-js/transactions';

const p = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const KEYS = join(homedir(), '.near-gliana');
const NEAR = 10n ** 24n;
const COLLECTION = process.env.COLLECTION ?? 'pixelwayfarers.testnet';
const POOL = process.env.POOL ?? 'kiln.pool.f863973.m0';
const STUDIO = 'wayfarers-studio.testnet';

async function exists(id: string) {
  return p.viewAccount(id).then(() => true, () => false);
}
/** A faucet account (10 testnet NEAR), its key saved owner-only before it's created. */
async function faucet(id: string): Promise<Account> {
  const file = join(KEYS, `${id}.json`);
  if (!existsSync(file)) {
    if (await exists(id)) throw new Error(`${id} exists but its key isn't in ${file}`);
    const kp = KeyPair.fromRandom('ed25519');
    mkdirSync(KEYS, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    const r = await fetch('https://helper.nearprotocol.com/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
    if (!r.ok) throw new Error(`faucet ${id}: ${r.status}`);
    await new Promise((res) => setTimeout(res, 2500));
  }
  const k = JSON.parse(readFileSync(file, 'utf8'));
  return new Account(id, p, new KeyPairSigner(KeyPair.fromString(k.private_key)));
}
const near = async (id: string) => Number(BigInt((await p.viewAccount(id)).amount) / 10n ** 21n) / 1000;
const view = (m: string, a: object = {}) => p.callFunction(COLLECTION, m, a) as Promise<any>;
const ok = (label: string, cond: boolean, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);

const purse = readFileSync('purse/target/near/wayfarer_purse.wasm');
const hash = createHash('sha256').update(purse).digest();
const collection = await faucet(COLLECTION);
const studio = await faucet(STUDIO);
// Reuse the test people from an earlier run when there are some: the faucet rate-limits new accounts.
import { readdirSync } from 'node:fs';
const earlier = (who: string) => readdirSync(KEYS).find((f) => f.startsWith(`wayfarers-${who}-`))?.replace(/\.json$/, '');
const person = (who: string) => faucet(earlier(who) ?? `wayfarers-${who}-${Date.now().toString(36)}.testnet`);
const alice = await person('alice');
const bob = await person('bob');
const carol = await person('carol');

// 1. The purse, published once by its code hash: nobody can change it afterwards.
let configured = false;
try {
  await view('config');
  configured = true;
} catch {
  /* fresh */
}
if (configured && process.env.REDEPLOY === '1') {
  // Code only; the stored state keeps its shape.
  await collection.deployContract(readFileSync('collection/target/near/wayfarers.wasm'));
  console.log('redeployed the collection code, state kept');
  await new Promise((res) => setTimeout(res, 3000));
}
if (!configured) {
  await collection.signAndSendTransaction({ receiverId: COLLECTION, actions: [actionCreators.deployGlobalContract(purse, new GlobalContractDeployMode({ CodeHash: null }))] });
  console.log('published the purse as a global contract, hash', hash.toString('hex').slice(0, 16), '…');
  await new Promise((res) => setTimeout(res, 3000)); // the next transaction from this key needs a fresh nonce
  await collection.deployContract(readFileSync('collection/target/near/wayfarers.wasm'));
  await new Promise((res) => setTimeout(res, 3000));
  const bs58 = (b: Buffer) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + b.toString('hex')); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; };
  await collection.callFunction({ contractId: COLLECTION, methodName: 'new', args: { owner: COLLECTION, studio: STUDIO, purse_code_hash: bs58(hash), mint_price: String(NEAR / 10n), purse_deposit: String(NEAR / 100n), commission_price: String(NEAR / 5n), studio_bps: 2000, max_supply: 1000, starting_index: 41, media_base: 'https://pixelwayfarers.com/art/full', reference_base: 'https://pixelwayfarers.com/art/meta', resale_bps: 500, pools: [POOL] }, gas: 100_000_000_000_000n });
  console.log('deployed and initialised', COLLECTION);
}

// 2. Alice mints: the token and its own account.
const before = (await view('config')).minted;
const had = new Set(((await view('nft_tokens_for_owner', { account_id: alice.accountId })) as any[]).map((t) => t.token_id));
await alice.callFunction({ contractId: COLLECTION, methodName: 'mint', args: {}, deposit: NEAR / 2n, gas: 100_000_000_000_000n });
const mine = await view('nft_tokens_for_owner', { account_id: alice.accountId });
const id: string = mine.find((t: any) => !had.has(t.token_id)).token_id;
const acct = `${id}.${COLLECTION}`;
const info = (await p.viewAccount(acct)) as any;
const keys = (await p.query({ request_type: 'view_access_key_list', finality: 'final', account_id: acct })) as any;
ok('mint creates the token', (await view('config')).minted === before + 1, `#${id}`);
ok('the token has its own account, with no keys', keys.keys.length === 0, `${acct}, ${await near(acct)} NEAR`);
const infoText = JSON.stringify(info, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
ok('that account runs the purse by its hash', infoText.includes(bs58fromHex(hash.toString('hex'))), infoText.slice(0, 160));

// 3. Carol gifts the Wayfarer a hobby item; the studio delivers; the royalty lands in the token's account.
const purseBefore = await near(acct);
await carol.callFunction({ contractId: COLLECTION, methodName: 'commission', args: { token_id: id, item: 0, note: 'a well-loved one' }, deposit: NEAR / 5n, gas: 30_000_000_000_000n });
const job = (await view('pending'))[0];
ok('the commission waits in escrow', Boolean(job), `#${job?.id}`);
await studio.callFunction({ contractId: COLLECTION, methodName: 'fulfil', args: { id: job.id, item_uri: 'https://pixelwayfarers.com/items/test.png' }, gas: 50_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));
const purseAfter = await near(acct);
ok('the royalty went to the token’s own account', purseAfter - purseBefore > 0.159, `${purseBefore} -> ${purseAfter} NEAR`);
ok('the item is on the token', (await view('items', { token_id: id })).length === 1);

// 4. Alice takes some out; then sells to Bob; Alice is locked out, Bob isn't.
const aliceBefore = await near(alice.accountId);
await alice.callFunction({ contractId: COLLECTION, methodName: 'withdraw', args: { token_id: id, amount: String(NEAR / 10n) }, deposit: 1n, gas: 50_000_000_000_000n });
await new Promise((res) => setTimeout(res, 3000)); // the payout lands a block or two after the call
ok('the holder withdrew 0.1 NEAR from the token', (await near(alice.accountId)) - aliceBefore > 0.09);
await alice.callFunction({ contractId: COLLECTION, methodName: 'nft_transfer', args: { receiver_id: bob.accountId, token_id: id }, deposit: 1n, gas: 30_000_000_000_000n });
let refused = false;
try {
  await alice.callFunction({ contractId: COLLECTION, methodName: 'withdraw', args: { token_id: id, amount: String(NEAR / 100n) }, deposit: 1n, gas: 50_000_000_000_000n });
} catch (e) {
  refused = /current holder/.test(String((e as Error).message));
}
ok('after the sale the seller can’t withdraw', refused);
const bobBefore = await near(bob.accountId);
await bob.callFunction({ contractId: COLLECTION, methodName: 'withdraw', args: { token_id: id, amount: String(NEAR / 20n) }, deposit: 1n, gas: 50_000_000_000_000n });
await new Promise((res) => setTimeout(res, 3000));
ok('the buyer can', (await near(bob.accountId)) - bobBefore > 0.04);
let direct = false;
try {
  const input = Buffer.concat([Buffer.from(new BigUint64Array([NEAR / 100n % (2n ** 64n), 0n]).buffer), Buffer.from(alice.accountId)]);
  await alice.signAndSendTransaction({ receiverId: acct, actions: [actionCreators.functionCall('pay', input, 10_000_000_000_000n, 0n)] });
} catch (e) {
  direct = /only the collection/.test(String((e as Error).message));
}
ok('nobody can call the token’s account directly', direct);

// 5. A marketplace sale (NEP-199): Bob lists via an approval, Carol (the "marketplace") sells to Alice, and pays out
//    as the payout says: 5% into the token's own account, the rest to Bob.
await bob.callFunction({ contractId: COLLECTION, methodName: 'nft_approve', args: { token_id: id, account_id: carol.accountId }, deposit: NEAR / 100n, gas: 30_000_000_000_000n });
const purseBeforeSale = await near(acct);
const out = (await carol.callFunction({ contractId: COLLECTION, methodName: 'nft_transfer_payout', args: { receiver_id: alice.accountId, token_id: id, approval_id: 1, balance: String(NEAR), max_len_payout: 10 }, deposit: 1n, gas: 50_000_000_000_000n })) as { payout: Record<string, string> };
for (const [to, amount] of Object.entries(out.payout)) await carol.transfer({ receiverId: to, amount: BigInt(amount) });
await new Promise((res) => setTimeout(res, 3000));
ok('a sale pays the token 5% into its own account', (await near(acct)) - purseBeforeSale > 0.049, `payout ${JSON.stringify(Object.fromEntries(Object.entries(out.payout).map(([k, v]) => [k.split('.')[0], Number(BigInt(v) / 10n ** 18n) / 1e6])))}`);
ok('and the buyer holds it', (await view('nft_token', { token_id: id })).owner_id === alice.accountId);

// 5b. The collection's own market: Alice lists it, Bob buys it; 5% goes into the token's account, Alice is paid.
await alice.callFunction({ contractId: COLLECTION, methodName: 'list', args: { token_id: id, price: String(NEAR / 2n) }, deposit: NEAR / 100n, gas: 30_000_000_000_000n });
const beforeBuy = await near(acct);
await new Promise((res) => setTimeout(res, 2500));
await bob.callFunction({ contractId: COLLECTION, methodName: 'buy', args: { token_id: id }, deposit: NEAR / 2n, gas: 50_000_000_000_000n });
await new Promise((res) => setTimeout(res, 3000));
ok('bought on the built-in market: Bob holds it', (await view('nft_token', { token_id: id })).owner_id === bob.accountId);
ok('and the token got 5% of the price into its own account', (await near(acct)) - beforeBuy > 0.024, `${beforeBuy} -> ${await near(acct)} NEAR`);
// Back to Alice for the staking step below, the same way.
await bob.callFunction({ contractId: COLLECTION, methodName: 'list', args: { token_id: id, price: String(NEAR / 10n) }, deposit: NEAR / 100n, gas: 30_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));
await alice.callFunction({ contractId: COLLECTION, methodName: 'buy', args: { token_id: id }, deposit: NEAR / 10n, gas: 50_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));

// 6. The new holder stakes some of the token's own NEAR with a validator; the stake belongs to the token's account.
await alice.callFunction({ contractId: COLLECTION, methodName: 'stake', args: { token_id: id, pool: POOL, amount: String(NEAR / 100n) }, deposit: 1n, gas: 150_000_000_000_000n });
await new Promise((res) => setTimeout(res, 4000));
const staked = BigInt((await p.callFunction(POOL, 'get_account_staked_balance', { account_id: acct })) as string);
ok('the token staked its own NEAR with a validator', staked > 0n, `${Number(staked / 10n ** 18n) / 1e6} NEAR staked by ${acct} at ${POOL}`);
// 7. The holder has the Wayfarer buy itself a hobby item with its own money (v3): its account pays, the order opens.
const beforeItem = await near(acct);
await alice.callFunction({ contractId: COLLECTION, methodName: 'buy_item', args: { token_id: id, item: 4 }, deposit: 1n, gas: 60_000_000_000_000n });
await new Promise((res) => setTimeout(res, 3000));
const own = (await view('pending', {})).filter((c: any) => c.token_id === id && c.buyer === acct);
ok('the Wayfarer bought itself an item: its account paid and the order is open', own.length > 0 && beforeItem - (await near(acct)) > 0.049, `${beforeItem} -> ${await near(acct)} NEAR, order ${own.at(-1)?.id}`);
// 8. A Wayfarer gifts another Wayfarer from its own money: Carol gifts it once more so it can afford 0.1 NEAR, then its
//    account pays for a hobby for #42.
await carol.callFunction({ contractId: COLLECTION, methodName: 'commission', args: { token_id: id, item: 2 }, deposit: NEAR / 5n, gas: 30_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));
const job2 = (await view('pending', {})).filter((c: any) => c.token_id === id && c.buyer === carol.accountId).at(-1);
await studio.callFunction({ contractId: COLLECTION, methodName: 'fulfil', args: { id: job2.id, item_uri: 'https://pixelwayfarers.com/items/test.png' }, gas: 50_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));
const beforeGive = await near(acct);
await alice.callFunction({ contractId: COLLECTION, methodName: 'gift_from', args: { token_id: id, to_token_id: '42', item: 7 }, deposit: 1n, gas: 60_000_000_000_000n });
await new Promise((res) => setTimeout(res, 3000));
const given = (await view('pending', {})).filter((c: any) => c.token_id === '42' && c.buyer === acct);
ok('a Wayfarer gifted another from its own money: an order for #42, paid by this token', given.length > 0 && beforeGive - (await near(acct)) > 0.099, `${beforeGive} -> ${await near(acct)} NEAR`);

// 9. Auto-stake: the holder switches it on, then anyone (Bob, who no longer holds it) can stake its idle NEAR for it.
await alice.callFunction({ contractId: COLLECTION, methodName: 'set_auto_stake', args: { token_id: id, pool: POOL }, deposit: 1n, gas: 30_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));
const stakedBefore = BigInt((await p.callFunction(POOL, 'get_account_staked_balance', { account_id: acct })) as string);
await bob.callFunction({ contractId: COLLECTION, methodName: 'auto_stake', args: { token_id: id, amount: String(NEAR / 100n) }, gas: 150_000_000_000_000n });
await new Promise((res) => setTimeout(res, 4000));
const stakedAfter = BigInt((await p.callFunction(POOL, 'get_account_staked_balance', { account_id: acct })) as string);
ok('auto-stake: someone else staked the token’s idle NEAR, in the token’s own name', stakedAfter > stakedBefore, `${Number(stakedBefore / 10n ** 18n) / 1e6} -> ${Number(stakedAfter / 10n ** 18n) / 1e6} NEAR staked`);
// 10. Items have a rarity rolled on chain, and Wayfarers trade them: Alice lists one of this token's items, and #42
//     (also hers) buys it with #42's own money; the item moves shelf to shelf and the price lands in this token's account.
const inv = await view('inventory', { token_id: id });
ok('items carry a rarity rolled on chain', inv.length > 0 && inv.every((i: any) => i.tier >= 0 && i.tier <= 4), inv.map((i: any) => `#${i.id}:tier${i.tier}`).join(' '));
const sale = inv[0];
await alice.callFunction({ contractId: COLLECTION, methodName: 'list_item', args: { token_id: id, item_id: sale.id, price: String(NEAR / 100n) }, deposit: 1n, gas: 30_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));
const sellerBefore = await near(acct);
await alice.callFunction({ contractId: COLLECTION, methodName: 'buy_listed_item', args: { buyer_token: '42', seller_token: id, item_id: sale.id, price: String(NEAR / 100n) }, deposit: 1n, gas: 60_000_000_000_000n });
await new Promise((res) => setTimeout(res, 3500));
const moved = (await view('inventory', { token_id: '42' })).some((i: any) => i.id === sale.id && i.painted_for === id);
ok('a Wayfarer bought another Wayfarer’s item with its own money: the item moved, the seller got paid', moved && (await near(acct)) - sellerBefore > 0.0099, `item #${sale.id} -> #42, ${sellerBefore} -> ${await near(acct)} NEAR`);
console.log('history:', JSON.stringify((await view('history', { token_id: id })).map((e: any) => `${e.what}:${e.account.split('.')[0]}`)));

function bs58fromHex(h: string) { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + h); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; }
