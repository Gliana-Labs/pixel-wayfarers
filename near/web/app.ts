/**
 * pixelwayfarers.com/near: Wayfarers that earn (NEAR HACKATHON 2026). Built to worker/public/near/app.js by
 * `npm run web` in near/. Reads the collection straight from NEAR RPC; every write is a transaction the visitor signs
 * in their own wallet. The Tavern sends a NEP-413 signed message the worker checks on every request.
 *
 * Wallets: MyNearWallet stopped accepting new app connections (Nov 2026) and testnet support in the other browser wallets
 * comes and goes, so "Try it free" makes a guest account instead. The browser makes a key, the worker creates
 * `g<random>.guest.pixelwayfarers.testnet` for it with 0.8 test NEAR, and this page signs with that key directly. The key
 * stays in this browser's localStorage: testnet only, and clearing site data loses the account.
 */
import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
(globalThis as unknown as { global: typeof globalThis }).global = globalThis;

import type { WalletSelector } from '@near-wallet-selector/core';

const NETWORK = 'testnet' as const;
const COLLECTION = 'pixelwayfarers.testnet';
// Public testnet RPCs that answer browsers (CORS *), checked 2026-11-09. FastNEAR rate-limits bursts (429), so a read
// that gets no answer moves on to the next one, and later reads start from whichever answered last.
const RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org', 'https://near-testnet.drpc.org'];
let rpcAt = 0;
const RPC = () => RPCS[rpcAt];
const EXPLORER = 'https://testnet.nearblocks.io';
const NEAR = 10n ** 24n;
const GAS = 100_000_000_000_000n;
// The collection's 12 hobby items, in its ITEMS order (`item` is the index).
const ITEMS = ['Acoustic guitar', 'Bowl of ramen', 'Corgi', 'Monstera plant', 'Skateboard', 'Film camera', 'Coffee mug', 'Stack of books', 'Game controller', 'Tabby cat', 'Basketball', 'Headphones',
  'Bicycle', 'Surfboard', 'Paint palette', 'Chess set', 'Telescope', 'Fishing rod', 'Violin', 'Roller skates', 'Bonsai tree', 'Goldfish', 'Hamster', 'Parrot',
  'Soccer ball', 'Tennis racket', 'Knitting', 'Record player', 'Laptop', 'Drone', 'Sushi', 'Cupcake', 'Teapot', 'Microphone', 'Camping tent', 'Electric guitar'];
// How the picker groups them (indexes into ITEMS).
const ITEM_GROUPS: [string, number[]][] = [
  ['Music', [0, 18, 27, 33, 35, 11]],
  ['Pets', [2, 9, 21, 22, 23]],
  ['Food & drink', [1, 6, 30, 31, 32]],
  ['Sports', [4, 10, 12, 13, 19, 24, 25]],
  ['Outdoors', [16, 17, 34, 20, 3]],
  ['Making & play', [5, 7, 8, 14, 15, 26, 28, 29]],
];
const TAVERN_RECIPIENT = 'pixelwayfarers.com';

type Token = { token_id: string; owner_id: string; metadata?: { extra?: string } };
type Item = { id: string; uri: string; kind: number; tier: number; painted_for: string; price: string | null; listed_by: string | null };
const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
type Offer = { id: string; buyer_token: string; amount: string; by: string; at: string };
type Entry = { at: string; what: string; account: string; amount: string };
type Listing = { seller: string; price: string; deposit: string; at: string };
const LISTING_DEPOSIT = NEAR / 100n;
type Config = { mint_price: string; purse_deposit: string; commission_price: string; studio_bps: number; minted: number; max_supply: number; paused: boolean; resale_bps: number; pools: string[]; item_price: string; peer_gift_price: string };

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (yocto: string | bigint, d = 3) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(d);
const short = (a: string) => (a.length > 26 ? `${a.slice(0, 14)}…${a.slice(-9)}` : a);
const ago = (s: string) => {
  const d = Date.now() / 1000 - Number(s);
  return d < 90 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : new Date(Number(s) * 1000).toLocaleDateString();
};

// Errors that say this RPC is busy or broken, not that the request is wrong; anything else (unknown account, a
// contract panic) is the real answer and is the same on every RPC.
const BUSY = /TOO_MANY|TIMEOUT|INTERNAL|UNAVAILABLE|NO_SYNCED|exceeded|rate/i;

// The home page reads ~60 things at once (each token's balance, listing and history); fired together they trip every
// public RPC's burst limit, so at most six are in flight.
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (inFlight >= 6) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await f();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

// When every RPC is busy at once (public testnet RPCs rate-limit bursts), wait and go round again, up to three rounds:
// a page that reads every shelf (the item market) otherwise shows half of them empty.
const rpc = <T>(params: object) => slot(async () => {
  for (let round = 0; ; round++) {
    try {
      return await rpcOnce<T>(params);
    } catch (e) {
      if (round >= 2 || !/no testnet RPC answered/.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (round + 1)));
    }
  }
});

async function rpcOnce<T>(params: object): Promise<T> {
  let last = 'no answer';
  for (let n = 0; n < RPCS.length; n++) {
    const i = (rpcAt + n) % RPCS.length;
    try {
      const res = await fetch(RPCS[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }), signal: AbortSignal.timeout(8000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.result) {
        rpcAt = i;
        return j.result as T;
      }
      const why = JSON.stringify(j.error?.cause?.name ?? j.error ?? 'no answer');
      if (!BUSY.test(why)) throw Object.assign(new Error(why), { final: true });
      last = why;
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      last = String((e as Error).message ?? e);
    }
  }
  throw new Error(`no testnet RPC answered (${last})`);
}
async function view<T>(method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>({ request_type: 'call_function', finality: 'final', account_id: COLLECTION, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}
async function poolView<T>(pool: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>({ request_type: 'call_function', finality: 'final', account_id: pool, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}
const balanceOf = (account: string) => rpc<{ amount: string }>({ request_type: 'view_account', finality: 'final', account_id: account }).then((r) => r.amount, () => '0');

let selector: WalletSelector | null = null;
let functionCall: ((m: string, a: object, g: bigint, d: bigint) => unknown) | null = null;

type Guest = { accountId: string; key: string };
const GUEST_KEY = 'wf-guest';
let guest: Guest | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(GUEST_KEY) ?? 'null') as Guest | null;
  } catch {
    return null;
  }
})();
const me = () => guest?.accountId ?? selector?.store.getState().accounts.find((a) => a.active)?.accountId ?? null;

async function guestAccount() {
  const [{ Account }, { JsonRpcProvider }, { KeyPairSigner }, { KeyPair }] = await Promise.all([import('@near-js/accounts'), import('@near-js/providers'), import('@near-js/signers'), import('@near-js/crypto')]);
  return new Account(guest!.accountId, new JsonRpcProvider({ url: RPC() }), new KeyPairSigner(KeyPair.fromString(guest!.key as `ed25519:${string}`)));
}

async function makeGuest() {
  const { KeyPair } = await import('@near-js/crypto');
  const kp = KeyPair.fromRandom('ed25519');
  const res = await fetch('/api/near/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ public_key: kp.getPublicKey().toString() }) });
  const j = (await res.json().catch(() => ({}))) as { account_id?: string; error?: string };
  if (!res.ok || !j.account_id) throw new Error(j.error ?? `guest account failed (${res.status})`);
  // The account exists once the worker answers, but an RPC node can lag a block or two behind: signing before it sees
  // the new key stalls the first transaction (seen 2026-11-09). Wait until the key is visible, up to ~20 s.
  for (let i = 0; i < 20; i++) {
    const seen = await rpc({ request_type: 'view_access_key', finality: 'final', account_id: j.account_id, public_key: kp.getPublicKey().toString() }).then(() => true, () => false);
    if (seen) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  guest = { accountId: j.account_id, key: kp.toString() };
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
  } catch {
    /* private window: the account lasts until the tab closes */
  }
}

async function call(method: string, args: object, deposit: bigint, back = location.href) {
  if (guest) {
    const out = await (await guestAccount()).callFunction({ contractId: COLLECTION, methodName: method, args, deposit, gas: GAS });
    // The page reads at `final`, about two blocks behind what the transaction just did.
    await new Promise((r) => setTimeout(r, 2500));
    return out;
  }
  if (!selector || !functionCall) throw new Error('Connect a wallet first.');
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({ receiverId: COLLECTION, actions: [functionCall(method, args, GAS, deposit)] as never, callbackUrl: back } as never);
}

function header() {
  const who = me();
  $('who').innerHTML = who
    ? `${guest ? '<span class="tag" title="A test account whose key lives in this browser">guest</span>' : ''}<a class="acct" href="${EXPLORER}/address/${esc(who)}" target="_blank" rel="noopener">${esc(short(who))}</a><button class="btn ghost" id="out">${guest ? 'Forget' : 'Disconnect'}</button>`
    : `<button class="btn" id="in-guest" title="Makes a NEAR testnet account with 0.8 test NEAR. No wallet app needed.">Try it free</button><button class="btn ghost" id="in-meteor">Meteor</button>`;
  $('who').querySelector('#out')?.addEventListener('click', async () => {
    if (guest) {
      if (!confirm('Forget this guest account? Its key lives only in this browser, so you won’t get it back.')) return;
      guest = null;
      try {
        localStorage.removeItem(GUEST_KEY);
      } catch {
        /* nothing stored */
      }
    } else await (await selector!.wallet()).signOut();
    route();
  });
  $('who').querySelector('#in-guest')?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    b.disabled = true;
    b.textContent = 'Making your account…';
    try {
      await makeGuest();
    } catch (e) {
      alert(String((e as Error).message ?? e));
    }
    route();
  });
  for (const [id, w] of [['in-meteor', 'meteor-wallet']] as const) {
    $('who').querySelector(`#${id}`)?.addEventListener('click', async () => {
      const wallet = (await selector!.wallet(w)) as unknown as { signIn: (o: object) => Promise<unknown> };
      await wallet.signIn({ contractId: COLLECTION, methodNames: [] });
      route();
    });
  }
}

const card = (t: Token, bal?: string, listing?: Listing | null, i = 0) =>
  `<a class="wf" style="--i:${i}" href="?token=${esc(t.token_id)}"><img src="/art/full/${esc(t.token_id)}.png" alt="Wayfarer #${esc(t.token_id)}" loading="lazy" width="256" height="256"><b>#${esc(t.token_id)}${itemCount(t) ? ` <span class="items-chip">${itemCount(t)} item${itemCount(t) > 1 ? 's' : ''}</span>` : ''}</b>${bal ? `<span class="bal"><b data-count="${fmt(bal)}">0.000</b> NEAR in its account</span>` : ''}${listing && listing.seller === t.owner_id ? `<span class="sale">For sale · ${fmt(listing.price, 2)} NEAR</span>` : ''}</a>`;

/** How many hobby items a token holds, from its metadata (`extra.items`, kept by the contract). */
function itemCount(t: Token): number {
  try {
    return Number((JSON.parse(t.metadata?.extra ?? '{}') as { items?: number }).items ?? 0);
  } catch {
    return 0;
  }
}

/** One item on a shelf: its sprite, a rarity tag, and a price tag when it's for sale. */
const itemTile = (it: Item, i: number, link = it.uri, best?: string) => {
  const name = `${ITEMS[it.kind] ?? 'Hobby item'} · ${TIER_NAMES[it.tier] ?? 'Common'}`;
  return `<a class="item t${it.tier}" style="--i:${i}" href="${esc(link)}" title="${esc(name)}, painted for #${esc(it.painted_for)}"><img src="${esc(it.uri)}" alt="${esc(name)}" loading="lazy" width="144" height="144"><span class="tier">${esc(TIER_NAMES[it.tier] ?? 'Common')}</span>${it.price ? `<span class="price">${fmt(it.price, 2)} NEAR</span>` : best ? `<span class="price offer">offer ${fmt(best, 2)}</span>` : ''}</a>`;
};
const itemLabel = (it: Item) => `${ITEMS[it.kind] ?? 'Hobby item'} · ${TIER_NAMES[it.tier] ?? 'Common'}${it.price ? ` · for sale ${fmt(it.price, 2)} NEAR` : ''}`;

async function home() {
  // Two reads draw the page; the ~60 per-token reads (balance, listing, history) fill it in as they land, newest first.
  const [cfg, tokens] = await Promise.all([view<Config>('config'), view<Token[]>('nft_tokens', { limit: 60 })]);
  const total = BigInt(cfg.mint_price) + BigInt(cfg.purse_deposit) + NEAR / 20n;
  const shown = location.search;
  $('main').innerHTML = `
    <section class="hero panel">
      <img class="hero-art" src="/art/city-street.png" alt="" width="1200" height="400">
      <h1>Wayfarers that earn</h1>
      <p class="lead">Each Wayfarer is a NEAR account of its own. Anyone can gift it a hobby, like a guitar, a bowl of ramen or a corgi: the studio paints the item onto its shelf, and <b>${100 - cfg.studio_bps / 100}% of the price lands in the Wayfarer’s own account</b>. It can spend what it earns on more hobbies. Sell the NFT and its account, its money and its access go with it.</p>
      <ol class="how"><li><b>Gift</b> any Wayfarer a hobby item</li><li><b>The studio paints it</b> onto its shelf, within minutes</li><li><b>${100 - cfg.studio_bps / 100}% lands in the Wayfarer’s own account</b>, plus ${cfg.resale_bps / 100}% of every resale</li><li><b>The holder</b> withdraws it, or stakes it with a NEAR validator</li></ol>
      <ul class="facts"><li>owns money: <code>42.${COLLECTION}</code>, a real account with no keys</li><li>earns from commissions, resales and staking</li><li>holds its items: a room that fills up, and buys more with its own money</li><li>opens the holders’ Tavern</li></ul>
      <div class="mint"><button class="btn big" id="mint" ${cfg.paused || cfg.minted >= cfg.max_supply ? 'disabled' : ''}>Mint a Wayfarer · ${fmt(cfg.mint_price, 2)} NEAR</button><span class="muted">${cfg.minted} of ${cfg.max_supply} minted · NEAR ${NETWORK} · the rest of your deposit comes back</span></div>
      <p class="muted small">${me() ? '' : '<b>No wallet needed.</b> This runs on NEAR testnet, and most NEAR wallets no longer connect to testnet apps (MyNearWallet stopped taking new ones in November 2026). <b>Try it free</b> (top right) makes you a real testnet account in this browser with 0.8 test NEAR: enough to mint, gift a hobby and enter the Tavern. Its key never leaves your browser. '}<a href="?tavern">Holders: the Tavern →</a></p>
    </section>
    <div id="tick"></div>
    <section class="panel"><h2>Wayfarers on NEAR</h2><div class="grid" id="cards">${tokens.slice().reverse().map((t, i) => card(t, undefined, null, i)).join('') || '<p class="muted">None minted yet.</p>'}</div></section>`;
  const still = () => location.search === shown && document.getElementById('cards');
  void Promise.all(tokens.slice().reverse().map(async (t, i) => {
    const [bal, listing] = await Promise.all([balanceOf(`${t.token_id}.${COLLECTION}`), view<Listing | null>('listing', { token_id: t.token_id }).catch(() => null)]);
    const el = still() && document.getElementById('cards')!.children[i];
    if (!el) return;
    el.outerHTML = card(t, bal, listing, i).replace('class="wf"', 'class="wf settled"');
    countUp();
  }));
  void Promise.all(tokens.slice(-12).map((t) => view<Entry[]>('history', { token_id: t.token_id }).then((h) => h.slice(0, 3).map((e) => ({ ...e, id: t.token_id }))).catch(() => []))).then((all) => {
    const recent = all.flat().sort((a, b) => Number(b.at) - Number(a.at)).slice(0, 14);
    const say: Record<string, string> = { minted: 'was minted', earned: 'got a gift worth', bought: 'bought itself an item for', gave: 'gifted another Wayfarer', sold_item: 'sold an item for', bought_item: 'bought an item for', auto_staked: 'auto-staked', sold: 'sold for', paid_out: 'paid its holder', transferred: 'changed hands', stake_requested: 'staked' };
    const tick = recent.map((e) => `<span>#${esc(e.id)} ${esc(say[e.what] ?? e.what)}${BigInt(e.amount) > 0n ? ` <b>${fmt(e.amount, 2)} NEAR</b>` : ''} · ${esc(ago(e.at))}</span>`).join('');
    if (tick && still()) $('tick').outerHTML = `<div class="ticker" aria-label="Recent activity"><div class="ticker-track">${tick}${tick}</div></div>`;
  });
  $('mint').addEventListener('click', (ev) => {
    (ev.currentTarget as HTMLButtonElement).disabled = true;
    void call('mint', {}, total).then(
      (t) => {
        const id = (t as Token | undefined)?.token_id;
        if (id) history.pushState(null, '', `?token=${id}`);
        scrollTo(0, 0); // the mint button sits low on the home page; the new Wayfarer's page starts at its top
        route();
      },
      (e) => {
        alert(String(e));
        route();
      },
    );
  });
}

/** Asks the studio to paint what's waiting now instead of at the next five-minute cron. */
const nudgeStudio = () => fetch('/api/near/deliver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);

async function tokenPage(id: string) {
  const account = `${id}.${COLLECTION}`;
  const cfg0 = await view<Config>('config');
  const stakes = await Promise.all(cfg0.pools.map(async (pool) => {
    const [staked, unstaked, ready] = await Promise.all([poolView<string>(pool, 'get_account_staked_balance', { account_id: account }).catch(() => '0'), poolView<string>(pool, 'get_account_unstaked_balance', { account_id: account }).catch(() => '0'), poolView<boolean>(pool, 'is_account_unstaked_balance_available', { account_id: account }).catch(() => false)]);
    return { pool, staked, unstaked, ready };
  }));
  const [t, cfg, history, allItems, bal, listing] = await Promise.all([view<Token | null>('nft_token', { token_id: id }), view<Config>('config'), view<Entry[]>('history', { token_id: id }), view<Item[]>('inventory', { token_id: id }), balanceOf(account), view<Listing | null>('listing', { token_id: id }).catch(() => null)]);
  if (!t) {
    $('main').innerHTML = `<section class="panel"><p>Wayfarer #${esc(id)} hasn’t been minted on NEAR yet. <a href="?">Back</a></p></section>`;
    return;
  }
  const holder = me() === t.owner_id;
  const [autoPool, mine] = await Promise.all([view<string | null>('auto_stake_of', { token_id: id }).catch(() => null), me() ? view<Token[]>('nft_tokens_for_owner', { account_id: me(), limit: 50 }).catch(() => []) : Promise.resolve([] as Token[])]);
  const givers = mine.filter((m) => m.token_id !== id);
  const items = allItems;
  const itemOffers = await Promise.all(items.map((it) => view<Offer[]>('offers', { item_id: it.id }).catch(() => [] as Offer[])));
  const mineIds = new Set(mine.map((m) => m.token_id));
  const offerRows = items.flatMap((it, k) => itemOffers[k].map((o) => ({ it, o })));
  const itemsForSale = items.filter((it) => it.price && it.listed_by === t.owner_id);
  const itemOptions = ITEM_GROUPS.map(([g, ids]) => `<optgroup label="${esc(g)}">${ids.map((i) => `<option value="${i}">${esc(ITEMS[i])}</option>`).join('')}</optgroup>`).join('');
  const words: Record<string, string> = { minted: 'Minted by', transferred: 'Now held by', earned: 'Got a gift, from', bought: 'Bought itself an item, from', gave: 'Gave a gift to', sold_item: 'Sold an item to', bought_item: 'Bought an item from', auto_staked: 'Auto-staked with', paid_out: 'Paid out to', sold: 'Sold to', stake_requested: 'Asked to stake with', unstake_requested: 'Asked to unstake from', withdraw_requested: 'Asked to withdraw stake from' };
  // Below 0.0001 NEAR is rounding left in the pool, not money to show.
  const DUST = 10n ** 20n;
  const stakeRows = stakes.filter((s) => BigInt(s.staked) > DUST || BigInt(s.unstaked) > DUST);
  const forSale = listing && listing.seller === t.owner_id ? listing : null;
  $('main').innerHTML = `
    <section class="panel token">
      <img class="art" src="/art/full/${esc(id)}.png" alt="Wayfarer #${esc(id)}" width="512" height="512">
      <div class="side">
        <h1>Wayfarer #${esc(id)}</h1>
        <dl><dt>Held by</dt><dd><a href="${EXPLORER}/address/${esc(t.owner_id)}">${esc(short(t.owner_id))}</a>${holder ? ' (you)' : ''}</dd>
        <dt>Its own account</dt><dd><a href="${EXPLORER}/address/${esc(account)}">${esc(account)}</a></dd>
        <dt>Money in it</dt><dd class="money"><b data-count="${fmt(bal)}">0.000</b> NEAR</dd>
        ${stakeRows.map((s) => `<dt>Staked</dt><dd class="money">${fmt(s.staked, 4)} NEAR <span class="muted small">with ${esc(s.pool.split('.')[0])}${BigInt(s.unstaked) > DUST ? ` · ${fmt(s.unstaked, 4)} unstaking${s.ready ? ', ready' : ''}` : ''}</span></dd>`).join('')}
        ${autoPool ? `<dt>Auto-stake</dt><dd>on, with ${esc(autoPool.split('.')[0])} <span class="muted small">its idle NEAR gets staked by itself</span></dd>` : ''}
        <dt>Earns from</dt><dd>gifts (${100 - cfg.studio_bps / 100}%), resales (${cfg.resale_bps / 100}%), staking</dd></dl>
        ${holder ? `<form id="wd" class="row"><input name="amt" inputmode="decimal" value="${Math.max(0, Number(fmt(bal, 4)) - 0.012).toFixed(3)}"><button class="btn">Withdraw to me</button></form><p class="muted small">Only whoever holds #${esc(id)} can take its money out; your wallet confirms.</p>
        <h3 class="mini">Stake its NEAR · earn rewards</h3>
        <div class="row"><button class="btn ${autoPool ? 'ghost' : ''}" id="auto">${autoPool ? 'Turn auto-stake off' : 'Turn on auto-stake'}</button></div>
        <p class="muted small">${autoPool ? 'On: every few hours, whatever #' + esc(id) + ' holds beyond 0.05 NEAR gets staked for it.' : 'Auto-stake: #' + esc(id) + ' stakes its own idle NEAR every few hours, keeping 0.05 NEAR to spend. It earns while you sleep.'}</p>
        <form id="st" class="row"><select name="pool">${cfg.pools.map((p) => `<option>${esc(p)}</option>`).join('')}</select><input name="amt" inputmode="decimal" value="0.01"><button class="btn ghost">Stake it</button></form>
        ${stakeRows.map((s) => `<div class="row"><button class="btn ghost" data-unstake="${esc(s.pool)}" data-amount="${esc(s.staked)}" ${BigInt(s.staked) > 0n ? '' : 'disabled'}>Unstake from ${esc(s.pool.split('.')[0])}</button><button class="btn ghost" data-withdraw="${esc(s.pool)}" ${s.ready && BigInt(s.unstaked) > DUST ? '' : 'disabled'}>Withdraw to #${esc(id)}</button></div>`).join('')}
        <p class="muted small">Lends #${esc(id)}’s own NEAR to a validator’s staking pool (${esc(cfg.pools.map((p) => p.split('.')[0]).join(', '))}, on testnet). The rewards go to #${esc(id)}, and a sale moves the stake with it. Unstaking takes about two days.</p>` : ''}
        <div class="market">${forSale
          ? `<h2>For sale · ${fmt(forSale.price, 2)} NEAR</h2>${holder ? '<button class="btn ghost" id="delist">Take it off sale</button>' : `<button class="btn big" id="buy">Buy #${esc(id)} with its account (${fmt(bal)} NEAR inside)</button>`}<p class="muted small">${cfg.resale_bps / 100}% of the price goes into #${esc(id)}’s own account, so it stays with the token for its next holder.</p>`
          : holder ? `<form id="ls" class="row"><input name="price" inputmode="decimal" value="1"><button class="btn ghost">Put it up for sale (NEAR)</button></form><p class="muted small">Whoever buys it gets its account and everything in it. ${cfg.resale_bps / 100}% of the price goes into the token’s account.</p>` : '<p class="muted small">Not for sale right now.</p>'}</div>
        ${holder ? `<form id="bi" class="commission"><h2>Let #${esc(id)} buy a hobby · ${fmt(cfg.item_price, 2)} NEAR from its own account</h2>
          <select name="item">${itemOptions}</select>
          <button class="btn">Buy it with #${esc(id)}’s money</button>
          <p class="muted small">Paid from #${esc(id)}’s account, not your wallet. The studio paints it onto its shelf within minutes; not delivered in 24 h, the money goes back to #${esc(id)}.</p></form>` : ''}
        ${givers.length ? `<form id="gf" class="commission"><h2>Gift from your Wayfarer · ${fmt(cfg.peer_gift_price, 2)} NEAR from its own account</h2>
          <select name="from">${givers.map((g) => `<option value="${esc(g.token_id)}">Wayfarer #${esc(g.token_id)}</option>`).join('')}</select>
          <select name="item">${itemOptions}</select>
          <button class="btn">Send it, Wayfarer to Wayfarer</button>
          <p class="muted small">Your Wayfarer pays from its own account. ${100 - cfg.studio_bps / 100}% lands in #${esc(id)}’s account when the item is delivered; not delivered in 24 h, the money goes back to yours.</p></form>` : ''}
        <form id="cm" class="commission"><h2>Gift #${esc(id)} a hobby · ${fmt(cfg.commission_price, 2)} NEAR</h2>
          <select name="item">${itemOptions}</select>
          <input name="note" maxlength="140" placeholder="A detail (optional): a red one">
          <button class="btn">Send the gift</button>
          <p class="muted small">${100 - cfg.studio_bps / 100}% of what you pay goes into #${esc(id)}’s own account when the studio delivers (usually within minutes). Not delivered in 24 h? You get it all back.</p></form>
      </div>
    </section>
    <section class="panel"><h2>Its room · ${items.length} item${items.length === 1 ? '' : 's'}</h2><div class="room">${items.length ? items.map((it, i) => itemTile(it, i, it.uri, itemOffers[i].reduce((b, o) => (BigInt(o.amount) > BigInt(b || '0') ? o.amount : b), ''))).join('') : '<p class="muted">An empty shelf: gift #' + esc(id) + ' its first hobby.</p>'}</div>
      ${holder && items.length ? `<form id="sell" class="row trade"><select name="item">${items.map((it) => `<option value="${esc(it.id)}">${esc(itemLabel(it))}</option>`).join('')}</select><input name="price" inputmode="decimal" value="0.1" aria-label="Price in NEAR"><button class="btn ghost" name="act" value="list">Put it on the market</button><button class="btn ghost" name="act" value="delist">Take it off</button></form>
      <p class="muted small">Another Wayfarer pays from its own account; the price lands in #${esc(id)}’s.</p>` : ''}
      ${!holder && givers.length && itemsForSale.length ? `<form id="buyitem" class="row trade"><select name="item">${itemsForSale.map((it) => `<option value="${esc(it.id)}|${esc(it.price)}">${esc(itemLabel(it))}</option>`).join('')}</select><select name="buyer">${givers.map((g) => `<option value="${esc(g.token_id)}">with Wayfarer #${esc(g.token_id)}’s money</option>`).join('')}</select><button class="btn">Buy it</button></form>
      <p class="muted small">Your Wayfarer pays from its own account and the item moves to its shelf. If the listing changes first, the money goes back.</p>` : ''}
      ${!holder && givers.length && items.length ? `<form id="offer" class="row trade"><select name="item">${items.map((it) => `<option value="${esc(it.id)}">${esc(itemLabel(it))}</option>`).join('')}</select><input name="amount" inputmode="decimal" value="0.05" aria-label="Offer in NEAR"><select name="buyer">${givers.map((g) => `<option value="${esc(g.token_id)}">from Wayfarer #${esc(g.token_id)}</option>`).join('')}</select><button class="btn ghost">Make an offer</button></form>
      <p class="muted small">Any item, for sale or not. Your Wayfarer’s money waits in escrow until #${esc(id)}’s holder accepts; cancel any time and it goes back.</p>` : ''}
      ${offerRows.length ? `<h3 class="mini">Offers</h3><table class="hist offers">${offerRows.map(({ it, o }) => `<tr><td>${esc(itemLabel({ ...it, price: null }))}</td><td class="money">${fmt(o.amount, 3)} NEAR</td><td>from <a href="?token=${esc(o.buyer_token)}">#${esc(o.buyer_token)}</a></td><td>${holder ? `<button class="btn" data-accept="${esc(o.id)}" data-item="${esc(it.id)}">Accept</button>` : mineIds.has(o.buyer_token) ? `<button class="btn ghost" data-cancel="${esc(o.id)}" data-item="${esc(it.id)}">Cancel</button>` : ''}</td></tr>`).join('')}</table>` : ''}</section>
    <section class="panel"><h2>History</h2><table class="hist">${history.map((e) => `<tr><td>${esc(words[e.what] ?? e.what)}</td><td><a href="${EXPLORER}/address/${esc(e.account)}">${esc(short(e.account))}</a></td><td class="money">${BigInt(e.amount) > 0n ? `${fmt(e.amount)} NEAR` : ''}</td><td class="muted">${esc(ago(e.at))}</td></tr>`).join('')}</table></section>`;
  $('cm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const item = Number((f.elements.namedItem('item') as HTMLSelectElement).value);
    const note = (f.elements.namedItem('note') as HTMLInputElement).value.trim();
    void call('commission', { token_id: id, item, note: note || null }, BigInt(cfg.commission_price))
      .then(nudgeStudio)
      .then(() => route(), (e) => alert(String(e)));
  });
  $('sell')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const act = ((ev as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? 'list';
    const itemId = (f.elements.namedItem('item') as HTMLSelectElement).value;
    const price = act === 'delist' ? null : yoctoOf((f.elements.namedItem('price') as HTMLInputElement).value);
    void call('list_item', { token_id: id, item_id: itemId, price }, 1n).then(() => route(), (e) => alert(String(e)));
  });
  $('offer')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const itemId = (f.elements.namedItem('item') as HTMLSelectElement).value;
    const buyer = (f.elements.namedItem('buyer') as HTMLSelectElement).value;
    const amount = yoctoOf((f.elements.namedItem('amount') as HTMLInputElement).value);
    void call('make_offer', { buyer_token: buyer, seller_token: id, item_id: itemId, amount }, 1n).then(() => route(), (e) => alert(String(e)));
  });
  document.querySelectorAll<HTMLButtonElement>('button[data-accept]').forEach((b) => b.addEventListener('click', () => void call('accept_offer', { seller_token: id, item_id: b.dataset.item, offer_id: b.dataset.accept }, 1n).then(() => route(), (e) => alert(String(e)))));
  document.querySelectorAll<HTMLButtonElement>('button[data-cancel]').forEach((b) => b.addEventListener('click', () => void call('cancel_offer', { item_id: b.dataset.item, offer_id: b.dataset.cancel }, 0n).then(() => route(), (e) => alert(String(e)))));
  $('buyitem')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const [itemId, price] = (f.elements.namedItem('item') as HTMLSelectElement).value.split('|');
    const buyer = (f.elements.namedItem('buyer') as HTMLSelectElement).value;
    void call('buy_listed_item', { buyer_token: buyer, seller_token: id, item_id: itemId, price }, 1n).then(() => route(), (e) => alert(String(e)));
  });
  $('auto')?.addEventListener('click', () => void call('set_auto_stake', { token_id: id, pool: autoPool ? null : cfg.pools[0] }, 1n).then(() => route(), (e) => alert(String(e))));
  $('gf')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const from = (f.elements.namedItem('from') as HTMLSelectElement).value;
    const item = Number((f.elements.namedItem('item') as HTMLSelectElement).value);
    void call('gift_from', { token_id: from, to_token_id: id, item }, 1n)
      .then(nudgeStudio)
      .then(() => route(), (e) => alert(String(e)));
  });
  $('bi')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const item = Number(((ev.target as HTMLFormElement).elements.namedItem('item') as HTMLSelectElement).value);
    void call('buy_item', { token_id: id, item }, 1n)
      .then(nudgeStudio)
      .then(() => route(), (e) => alert(String(e)));
  });
  const yoctoOf = (v: string) => {
    const [whole, frac = ''] = v.trim().split('.');
    return (BigInt(whole || '0') * NEAR + BigInt((frac + '0'.repeat(24)).slice(0, 24))).toString();
  };
  countUp();
  $('buy')?.addEventListener('click', () => void call('buy', { token_id: id }, BigInt(forSale!.price)).then(() => route(), (e) => alert(String(e))));
  $('delist')?.addEventListener('click', () => void call('delist', { token_id: id }, 0n).then(() => route(), (e) => alert(String(e))));
  $('ls')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const price = yoctoOf(((ev.target as HTMLFormElement).elements.namedItem('price') as HTMLInputElement).value);
    void call('list', { token_id: id, price }, LISTING_DEPOSIT).then(() => route(), (e) => alert(String(e)));
  });
  $('st')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const pool = (f.elements.namedItem('pool') as HTMLSelectElement).value;
    const amount = yoctoOf((f.elements.namedItem('amt') as HTMLInputElement).value);
    void call('stake', { token_id: id, pool, amount }, 1n).then(() => route(), (e) => alert(String(e)));
  });
  document.querySelectorAll<HTMLButtonElement>('button[data-unstake]').forEach((b) => b.addEventListener('click', () => void call('unstake', { token_id: id, pool: b.dataset.unstake, amount: b.dataset.amount }, 1n).then(() => route(), (e) => alert(String(e)))));
  document.querySelectorAll<HTMLButtonElement>('button[data-withdraw]').forEach((b) => b.addEventListener('click', () => void call('withdraw_stake', { token_id: id, pool: b.dataset.withdraw }, 1n).then(() => route(), (e) => alert(String(e)))));
  $('wd')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const amt = (ev.target as HTMLFormElement).elements.namedItem('amt') as HTMLInputElement;
    const [whole, frac = ''] = amt.value.trim().split('.');
    const yocto = BigInt(whole || '0') * NEAR + BigInt((frac + '0'.repeat(24)).slice(0, 24));
    void call('withdraw', { token_id: id, amount: yocto.toString() }, 1n).then(() => route(), (e) => alert(String(e)));
  });
}

/** Balances count up from zero when the page draws: money arriving, not numbers sitting there. */
function countUp() {
  // Only numbers not counted yet: cards fill in one by one and each counts up once.
  const els = [...document.querySelectorAll<HTMLElement>('[data-count]:not([data-counted])')];
  for (const e of els) e.dataset.counted = '1';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return els.forEach((e) => (e.textContent = e.dataset.count!));
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / 1100);
    const ease = 1 - (1 - k) ** 3;
    for (const e of els) e.textContent = (Number(e.dataset.count) * ease).toFixed(3);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── the Tavern ───────────────────────────────────────────────────────────────

async function tavernRequest(signed: { accountId: string; publicKey: string; signature: string }, message: string, nonce: string, post?: string) {
  const res = await fetch('/api/near/tavern', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...signed, message, nonce, recipient: TAVERN_RECIPIENT, post }) });
  return res.json();
}

async function tavern() {
  // A browser wallet signs on its own page and comes back with the signature in the URL fragment.
  const back = new URLSearchParams(location.hash.slice(1));
  const pending = sessionStorage.getItem('tavern');
  let session: { signed: { accountId: string; publicKey: string; signature: string }; message: string; nonce: string } | null = null;
  if (back.get('signature') && pending) {
    const { message, nonce } = JSON.parse(pending);
    session = { signed: { accountId: back.get('accountId')!, publicKey: back.get('publicKey')!, signature: back.get('signature')! }, message, nonce };
    history.replaceState(null, '', `${location.pathname}?tavern`);
  }
  const show = (data: { error?: string; holder?: { account: string; tokens: string[] }; board?: { account: string; text: string; at: number }[] }) => {
    if (data.error) {
      $('main').innerHTML = `<section class="panel"><h1>The Tavern</h1><p class="warn">${esc(data.error)}</p><p class="muted">Only accounts holding a Wayfarer right now get in, checked on every visit. <a href="?">Mint one</a>.</p></section>`;
      return;
    }
    $('main').innerHTML = `<section class="panel"><h1>The Tavern</h1><p class="lead">Welcome, ${esc(short(data.holder!.account))}: holder of ${data.holder!.tokens.map((t) => `<a href="?token=${esc(t)}">#${esc(t)}</a>`).join(', ')}.</p>
      <form id="post" class="row"><input name="text" maxlength="140" placeholder="Say something to the other holders"><button class="btn">Post</button></form>
      <ul class="board">${(data.board ?? []).map((p) => `<li><b>${esc(short(p.account))}</b> ${esc(p.text)} <span class="muted small">${esc(ago(String(Math.round(p.at / 1000))))}</span></li>`).join('') || '<li class="muted">Quiet so far.</li>'}</ul>
      <p class="muted small">Sell your Wayfarer and you’re out on the next visit: there’s no session to keep, the Tavern asks NEAR who holds one each time.</p></section>`;
    $('post').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = ((ev.target as HTMLFormElement).elements.namedItem('text') as HTMLInputElement).value;
      void tavernRequest(session!.signed, session!.message, session!.nonce, text).then(show);
    });
  };
  if (session) return show(await tavernRequest(session.signed, session.message, session.nonce));
  $('main').innerHTML = `<section class="panel"><h1>The Tavern</h1><p class="lead">The holders’ room. Sign a message with your NEAR wallet to prove which account you are; only accounts holding a Wayfarer right now get in.</p><button class="btn big" id="enter" ${me() ? '' : 'disabled'}>Sign and enter</button>${me() ? '' : '<p class="muted">Connect a wallet first (top right).</p>'}</section>`;
  $('enter').addEventListener('click', async () => {
    const message = `Enter the Pixel Wayfarers Tavern at ${Date.now()}`;
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = btoa(String.fromCharCode(...nonceBytes));
    if (guest) {
      const s = await (await guestAccount()).signNep413Message({ message, recipient: TAVERN_RECIPIENT, nonce: nonceBytes });
      session = { signed: { accountId: s.accountId, publicKey: s.publicKey.toString(), signature: Buffer.from(s.signature).toString('base64') }, message, nonce };
      return show(await tavernRequest(session.signed, message, nonce));
    }
    sessionStorage.setItem('tavern', JSON.stringify({ message, nonce }));
    const wallet = await selector!.wallet();
    const signed = (await (wallet as unknown as { signMessage: (p: object) => Promise<{ accountId: string; publicKey: string; signature: string } | void> }).signMessage({ message, recipient: TAVERN_RECIPIENT, nonce: Buffer.from(nonceBytes), callbackUrl: `${location.origin}${location.pathname}?tavern` })) ?? null;
    if (signed) {
      session = { signed, message, nonce };
      show(await tavernRequest(signed, message, nonce));
    }
  });
}

// ── the item market: every item a Wayfarer has up for sale ─────────────────────────────────────────

async function market() {
  const tokens = await view<Token[]>('nft_tokens', { limit: 100 });
  $('main').innerHTML = `<section class="panel"><h1>Item market</h1><p class="lead">Every hobby item on every Wayfarer’s shelf. Buy the ones for sale, or <b>make an offer on any of them</b>: a Wayfarer pays with its own money, and the item moves to its shelf. Rarity is rolled on chain when an item is made: nobody picks it.</p>
    <div class="row tiers" id="scope"><button class="btn ghost" data-scope="sale" aria-pressed="true">For sale</button><button class="btn ghost" data-scope="all">All items</button></div>
    <div class="row tiers" id="tiers"><button class="btn ghost" data-tier="all" aria-pressed="true">Any rarity</button>${TIER_NAMES.map((n, i) => `<button class="btn ghost t${i}" data-tier="${i}">${n}</button>`).join('')}</div>
    <div class="room market" id="mk"><p class="muted">Reading every shelf on NEAR…</p></div></section>`;
  const all: { it: Item; t: Token; forSale: boolean; best: string }[] = [];
  await Promise.all(tokens.map(async (t) => {
    const inv = await view<Item[]>('inventory', { token_id: t.token_id }).catch(() => [] as Item[]);
    await Promise.all(inv.map(async (it) => {
      const offs = await view<Offer[]>('offers', { item_id: it.id }).catch(() => [] as Offer[]);
      const best = offs.reduce((b, o) => (BigInt(o.amount) > BigInt(b || '0') ? o.amount : b), '');
      all.push({ it, t, forSale: Boolean(it.price && it.listed_by === t.owner_id), best });
    }));
  }));
  all.sort((a, b) => Number(b.forSale) - Number(a.forSale) || b.it.tier - a.it.tier || Number(BigInt(a.it.price ?? '0') - BigInt(b.it.price ?? '0')));
  let scope = 'sale';
  let tier = 'all';
  const draw = () => {
    const shown = all.filter((x) => (scope === 'all' || x.forSale) && (tier === 'all' || String(x.it.tier) === tier));
    $('mk').innerHTML = shown.length
      ? shown.map((x, i) => `<div class="market-cell">${itemTile(x.forSale ? x.it : { ...x.it, price: null }, i, `?token=${x.t.token_id}`, x.best)}<span class="small muted">on #${esc(x.t.token_id)}’s shelf${x.forSale ? '' : ' · make an offer'}</span></div>`).join('')
      : `<p class="muted">${scope === 'sale' ? 'Nothing for sale with that rarity yet. Try “All items” and make an offer.' : 'No items with that rarity yet.'}</p>`;
  };
  draw();
  const pick = (group: string, set: (v: string) => void) => document.querySelectorAll<HTMLButtonElement>(`#${group} button`).forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll(`#${group} button`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    set(b.dataset.scope ?? b.dataset.tier!);
    draw();
  }));
  pick('scope', (v) => (scope = v));
  pick('tiers', (v) => (tier = v));
}

async function route() {
  header();
  const q = new URLSearchParams(location.search);
  $('nav-home').toggleAttribute('aria-current', !q.has('tavern') && !q.has('market'));
  $('nav-market').toggleAttribute('aria-current', q.has('market'));
  $('nav-tavern').toggleAttribute('aria-current', q.has('tavern'));
  try {
    if (q.has('tavern')) await tavern();
    else if (q.has('market')) await market();
    else if (q.get('token')) await tokenPage(q.get('token')!);
    else await home();
  } catch (e) {
    $('main').innerHTML = `<section class="panel"><p class="warn">Couldn’t read the collection from NEAR: ${esc(String((e as Error).message ?? e))}. Try again in a moment.</p></section>`;
  }
}

void (async () => {
  void route();
  const [core, meteor] = await Promise.all([import('@near-wallet-selector/core'), import('@near-wallet-selector/meteor-wallet')]);
  functionCall = core.actionCreators.functionCall as never;
  selector = await core.setupWalletSelector({ network: NETWORK, modules: [meteor.setupMeteorWallet()] });
  let seen = me();
  selector.store.observable.subscribe(() => {
    if (me() !== seen) {
      seen = me();
      void route();
    }
  });
  // The page is already drawn; the wallet only changes the header. A wallet that restores a session changes me(), and
  // the subscription above redraws for that. (Redrawing here reset whatever the visitor had clicked meanwhile.)
  header();
})();
