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
const COLLECTION = 'pixel-wayfarers.testnet';
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
if (!configured) {
  await collection.signAndSendTransaction({ receiverId: COLLECTION, actions: [actionCreators.deployGlobalContract(purse, new GlobalContractDeployMode({ CodeHash: null }))] });
  console.log('published the purse as a global contract, hash', hash.toString('hex').slice(0, 16), '…');
  await collection.deployContract(readFileSync('collection/target/near/wayfarers.wasm'));
  const bs58 = (b: Buffer) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + b.toString('hex')); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; };
  await collection.callFunction({ contractId: COLLECTION, methodName: 'new', args: { owner: COLLECTION, studio: STUDIO, purse_code_hash: bs58(hash), mint_price: String(NEAR / 10n), purse_deposit: String(NEAR / 100n), commission_price: String(NEAR / 5n), studio_bps: 2000, max_supply: 1000, starting_index: 41, media_base: 'https://pixelwayfarers.com/art/full', reference_base: 'https://pixelwayfarers.com/art/meta' }, gas: 100_000_000_000_000n });
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

// 3. Carol commissions a scene; the studio delivers; the royalty lands in the token's account.
const purseBefore = await near(acct);
await carol.callFunction({ contractId: COLLECTION, methodName: 'commission', args: { token_id: id, scene: 3, note: 'at a Bali night market' }, deposit: NEAR / 5n, gas: 30_000_000_000_000n });
const job = (await view('pending'))[0];
ok('the commission waits in escrow', Boolean(job), `#${job?.id}`);
await studio.callFunction({ contractId: COLLECTION, methodName: 'fulfil', args: { id: job.id, scene_uri: 'https://pixelwayfarers.com/scenes/test.png' }, gas: 50_000_000_000_000n });
await new Promise((res) => setTimeout(res, 2500));
const purseAfter = await near(acct);
ok('the royalty went to the token’s own account', purseAfter - purseBefore > 0.159, `${purseBefore} -> ${purseAfter} NEAR`);
ok('the scene is on the token', (await view('scenes', { token_id: id })).length === 1);

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
console.log('history:', JSON.stringify((await view('history', { token_id: id })).map((e: any) => `${e.what}:${e.account.split('.')[0]}`)));

function bs58fromHex(h: string) { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + h); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; }
