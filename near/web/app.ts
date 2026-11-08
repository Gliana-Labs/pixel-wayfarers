/**
 * pixelwayfarers.com/near: Wayfarers that earn (NEAR HACKATHON 2026). Built to worker/public/near/app.js by
 * `npm run web` in near/. Reads the collection straight from NEAR RPC; every write is a transaction the visitor signs
 * in their own wallet. The Tavern sends a NEP-413 signed message the worker checks on every request.
 */
import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
(globalThis as unknown as { global: typeof globalThis }).global = globalThis;

import type { WalletSelector } from '@near-wallet-selector/core';

const NETWORK = 'testnet' as const;
const COLLECTION = 'pixelwayfarers.testnet';
const RPC = 'https://test.rpc.fastnear.com';
const EXPLORER = 'https://testnet.nearblocks.io';
const NEAR = 10n ** 24n;
const GAS = 100_000_000_000_000n;
const SCENES = ['Bali night market', 'Rainy Tokyo alley', 'Mountain sunrise camp', 'Space station window', 'Cozy library', 'Beach at sunset', 'Snowy cabin', 'Desert caravan under the stars', 'Sunken ruins', 'Cherry blossom park', 'Retro arcade', 'Harvest festival'];
const TAVERN_RECIPIENT = 'pixelwayfarers.com';

type Token = { token_id: string; owner_id: string; metadata?: { extra?: string } };
type Entry = { at: string; what: string; account: string; amount: string };
type Listing = { seller: string; price: string; deposit: string; at: string };
const LISTING_DEPOSIT = NEAR / 100n;
type Config = { mint_price: string; purse_deposit: string; commission_price: string; studio_bps: number; minted: number; max_supply: number; paused: boolean; resale_bps: number; pools: string[] };

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (yocto: string | bigint, d = 3) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(d);
const short = (a: string) => (a.length > 26 ? `${a.slice(0, 14)}…${a.slice(-9)}` : a);
const ago = (s: string) => {
  const d = Date.now() / 1000 - Number(s);
  return d < 90 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : new Date(Number(s) * 1000).toLocaleDateString();
};

async function rpc<T>(params: object): Promise<T> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }) });
  const j = await res.json();
  if (!j.result) throw new Error(JSON.stringify(j.error?.cause?.name ?? j.error ?? 'no answer'));
  return j.result as T;
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
const me = () => selector?.store.getState().accounts.find((a) => a.active)?.accountId ?? null;

async function call(method: string, args: object, deposit: bigint, back = location.href) {
  if (!selector || !functionCall) throw new Error('Connect a wallet first.');
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({ receiverId: COLLECTION, actions: [functionCall(method, args, GAS, deposit)] as never, callbackUrl: back } as never);
}

function header() {
  const who = me();
  $('who').innerHTML = who
    ? `<span class="acct">${esc(short(who))}</span><button class="btn ghost" id="out">Disconnect</button>`
    : `<button class="btn" id="in-my">MyNearWallet</button><button class="btn ghost" id="in-meteor">Meteor</button>`;
  $('who').querySelector('#out')?.addEventListener('click', async () => {
    await (await selector!.wallet()).signOut();
    route();
  });
  for (const [id, w] of [['in-my', 'my-near-wallet'], ['in-meteor', 'meteor-wallet']] as const) {
    $('who').querySelector(`#${id}`)?.addEventListener('click', async () => {
      const wallet = (await selector!.wallet(w)) as unknown as { signIn: (o: object) => Promise<unknown> };
      await wallet.signIn({ contractId: COLLECTION, methodNames: [] });
      route();
    });
  }
}

const card = (t: Token, bal?: string, listing?: Listing | null, i = 0) =>
  `<a class="wf" style="--i:${i}" href="?token=${esc(t.token_id)}"><img src="/art/full/${esc(t.token_id)}.png" alt="Wayfarer #${esc(t.token_id)}" loading="lazy" width="256" height="256"><b>#${esc(t.token_id)}</b>${bal ? `<span class="bal"><b data-count="${fmt(bal)}">0.000</b> NEAR in its account</span>` : ''}${listing && listing.seller === t.owner_id ? `<span class="sale">For sale · ${fmt(listing.price, 2)} NEAR</span>` : ''}</a>`;

async function home() {
  const [cfg, tokens] = await Promise.all([view<Config>('config'), view<Token[]>('nft_tokens', { limit: 60 })]);
  const [bals, listed] = await Promise.all([Promise.all(tokens.map((t) => balanceOf(`${t.token_id}.${COLLECTION}`))), Promise.all(tokens.map((t) => view<Listing | null>('listing', { token_id: t.token_id }).catch(() => null)))]);
  const total = BigInt(cfg.mint_price) + BigInt(cfg.purse_deposit) + NEAR / 20n;
  const recent = (await Promise.all(tokens.slice(-12).map((t) => view<Entry[]>('history', { token_id: t.token_id }).then((h) => h.slice(0, 3).map((e) => ({ ...e, id: t.token_id }))).catch(() => [])))).flat().sort((a, b) => Number(b.at) - Number(a.at)).slice(0, 14);
  const say: Record<string, string> = { minted: 'was minted', earned: 'earned', sold: 'sold for', paid_out: 'paid its holder', transferred: 'changed hands', stake_requested: 'staked' };
  const tick = recent.map((e) => `<span>#${esc(e.id)} ${esc(say[e.what] ?? e.what)}${BigInt(e.amount) > 0n ? ` <b>${fmt(e.amount, 2)} NEAR</b>` : ''} · ${esc(ago(e.at))}</span>`).join('');
  $('main').innerHTML = `
    <section class="hero panel">
      <img class="hero-art" src="/art/city-street.png" alt="" width="1200" height="400">
      <h1>Wayfarers that earn</h1>
      <p class="lead">Each Wayfarer is a NEAR account of its own. Anyone can commission a new scene starring it; the studio paints it in the collection’s style, and <b>${100 - cfg.studio_bps / 100}% of the price lands in the Wayfarer’s own account</b>. Sell the NFT and its account, its money and its access go with it.</p>
      <ol class="how"><li><b>Commission</b> a scene starring any Wayfarer</li><li><b>The studio paints it</b> in the collection’s style, within minutes</li><li><b>${100 - cfg.studio_bps / 100}% lands in the Wayfarer’s own account</b>, plus ${cfg.resale_bps / 100}% of every resale</li><li><b>The holder</b> withdraws it, or stakes it with a NEAR validator</li></ol>
      <ul class="facts"><li>owns money: <code>42.${COLLECTION}</code>, a real account with no keys</li><li>earns from commissions, resales and staking</li><li>holds its scenes, a gallery that grows</li><li>opens the holders’ Tavern</li></ul>
      <div class="mint"><button class="btn big" id="mint" ${cfg.paused || cfg.minted >= cfg.max_supply ? 'disabled' : ''}>Mint a Wayfarer · ${fmt(cfg.mint_price, 2)} NEAR</button><span class="muted">${cfg.minted} of ${cfg.max_supply} minted · NEAR ${NETWORK} · the rest of your deposit comes back</span></div>
      <p class="muted small">Testnet: free test NEAR at <a href="https://near-faucet.io">near-faucet.io</a>. <a href="?tavern">Holders: the Tavern →</a></p>
    </section>
    ${tick ? `<div class="ticker" aria-label="Recent activity"><div class="ticker-track">${tick}${tick}</div></div>` : ''}
    <section class="panel"><h2>Wayfarers on NEAR</h2><div class="grid">${tokens.map((t, i) => card(t, bals[i], listed[i], i)).join('') || '<p class="muted">None minted yet.</p>'}</div></section>`;
  countUp();
  $('mint').addEventListener('click', () => void call('mint', {}, total).then(() => route(), (e) => alert(String(e))));
}

async function tokenPage(id: string) {
  const account = `${id}.${COLLECTION}`;
  const cfg0 = await view<Config>('config');
  const stakes = await Promise.all(cfg0.pools.map(async (pool) => {
    const [staked, unstaked, ready] = await Promise.all([poolView<string>(pool, 'get_account_staked_balance', { account_id: account }).catch(() => '0'), poolView<string>(pool, 'get_account_unstaked_balance', { account_id: account }).catch(() => '0'), poolView<boolean>(pool, 'is_account_unstaked_balance_available', { account_id: account }).catch(() => false)]);
    return { pool, staked, unstaked, ready };
  }));
  const [t, cfg, history, scenes, bal, listing] = await Promise.all([view<Token | null>('nft_token', { token_id: id }), view<Config>('config'), view<Entry[]>('history', { token_id: id }), view<string[]>('scenes', { token_id: id }), balanceOf(account), view<Listing | null>('listing', { token_id: id }).catch(() => null)]);
  if (!t) {
    $('main').innerHTML = `<section class="panel"><p>Wayfarer #${esc(id)} hasn’t been minted on NEAR yet. <a href="?">Back</a></p></section>`;
    return;
  }
  const holder = me() === t.owner_id;
  const words: Record<string, string> = { minted: 'Minted by', transferred: 'Now held by', earned: 'Earned, from', paid_out: 'Paid out to', sold: 'Sold to', stake_requested: 'Asked to stake with', unstake_requested: 'Asked to unstake from', withdraw_requested: 'Asked to withdraw stake from' };
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
        <dt>Earns from</dt><dd>commissions (${100 - cfg.studio_bps / 100}%), resales (${cfg.resale_bps / 100}%), staking</dd></dl>
        ${holder ? `<form id="wd" class="row"><input name="amt" inputmode="decimal" value="${Math.max(0, Number(fmt(bal, 4)) - 0.012).toFixed(3)}"><button class="btn">Withdraw to me</button></form><p class="muted small">Only whoever holds #${esc(id)} can take its money out; your wallet confirms.</p>
        <form id="st" class="row"><select name="pool">${cfg.pools.map((p) => `<option>${esc(p)}</option>`).join('')}</select><input name="amt" inputmode="decimal" value="0.01"><button class="btn ghost">Stake it</button></form>
        ${stakeRows.map((s) => `<div class="row"><button class="btn ghost" data-unstake="${esc(s.pool)}" data-amount="${esc(s.staked)}" ${BigInt(s.staked) > 0n ? '' : 'disabled'}>Unstake from ${esc(s.pool.split('.')[0])}</button><button class="btn ghost" data-withdraw="${esc(s.pool)}" ${s.ready && BigInt(s.unstaked) > DUST ? '' : 'disabled'}>Withdraw to #${esc(id)}</button></div>`).join('')}
        <p class="muted small">Staking keeps the money in #${esc(id)}’s name: rewards accrue to the token, and a sale moves the stake too.</p>` : ''}
        <div class="market">${forSale
          ? `<h2>For sale · ${fmt(forSale.price, 2)} NEAR</h2>${holder ? '<button class="btn ghost" id="delist">Take it off sale</button>' : `<button class="btn big" id="buy">Buy #${esc(id)} with its account (${fmt(bal)} NEAR inside)</button>`}<p class="muted small">${cfg.resale_bps / 100}% of the price goes into #${esc(id)}’s own account, so it stays with the token for its next holder.</p>`
          : holder ? `<form id="ls" class="row"><input name="price" inputmode="decimal" value="1"><button class="btn ghost">Put it up for sale (NEAR)</button></form><p class="muted small">Whoever buys it gets its account and everything in it. ${cfg.resale_bps / 100}% of the price goes into the token’s account.</p>` : '<p class="muted small">Not for sale right now.</p>'}</div>
        <form id="cm" class="commission"><h2>Commission a scene · ${fmt(cfg.commission_price, 2)} NEAR</h2>
          <select name="scene">${SCENES.map((s, i) => `<option value="${i}">${esc(s)}</option>`).join('')}</select>
          <input name="note" maxlength="140" placeholder="A detail (optional): holding a lantern">
          <button class="btn">Commission it</button>
          <p class="muted small">${100 - cfg.studio_bps / 100}% goes to #${esc(id)}’s account when the studio delivers (usually within minutes). Not delivered in 24 h? You get it all back.</p></form>
      </div>
    </section>
    <section class="panel"><h2>Scenes it holds (${scenes.length})</h2><div class="grid">${scenes.slice().reverse().map((u) => `<a class="wf" href="${esc(u)}"><img src="${esc(u)}" alt="Scene" loading="lazy" width="256" height="256"></a>`).join('') || '<p class="muted">No scenes yet: commission the first one.</p>'}</div></section>
    <section class="panel"><h2>History</h2><table class="hist">${history.map((e) => `<tr><td>${esc(words[e.what] ?? e.what)}</td><td><a href="${EXPLORER}/address/${esc(e.account)}">${esc(short(e.account))}</a></td><td class="money">${BigInt(e.amount) > 0n ? `${fmt(e.amount)} NEAR` : ''}</td><td class="muted">${esc(ago(e.at))}</td></tr>`).join('')}</table></section>`;
  $('cm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const scene = Number((f.elements.namedItem('scene') as HTMLSelectElement).value);
    const note = (f.elements.namedItem('note') as HTMLInputElement).value.trim();
    void call('commission', { token_id: id, scene, note: note || null }, BigInt(cfg.commission_price))
      .then(() => fetch('/api/near/deliver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
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
  const els = [...document.querySelectorAll<HTMLElement>('[data-count]')];
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
    sessionStorage.setItem('tavern', JSON.stringify({ message, nonce }));
    const wallet = await selector!.wallet();
    const signed = (await (wallet as unknown as { signMessage: (p: object) => Promise<{ accountId: string; publicKey: string; signature: string } | void> }).signMessage({ message, recipient: TAVERN_RECIPIENT, nonce: Buffer.from(nonceBytes), callbackUrl: `${location.origin}${location.pathname}?tavern` })) ?? null;
    if (signed) {
      session = { signed, message, nonce };
      show(await tavernRequest(signed, message, nonce));
    }
  });
}

async function route() {
  header();
  const q = new URLSearchParams(location.search);
  try {
    if (q.has('tavern')) await tavern();
    else if (q.get('token')) await tokenPage(q.get('token')!);
    else await home();
  } catch (e) {
    $('main').innerHTML = `<section class="panel"><p class="warn">Couldn’t read the collection from NEAR: ${esc(String((e as Error).message ?? e))}. Try again in a moment.</p></section>`;
  }
}

void (async () => {
  void route();
  const [core, myNear, meteor] = await Promise.all([import('@near-wallet-selector/core'), import('@near-wallet-selector/my-near-wallet'), import('@near-wallet-selector/meteor-wallet')]);
  functionCall = core.actionCreators.functionCall as never;
  selector = await core.setupWalletSelector({ network: NETWORK, modules: [myNear.setupMyNearWallet(), meteor.setupMeteorWallet()] });
  let seen = me();
  selector.store.observable.subscribe(() => {
    if (me() !== seen) {
      seen = me();
      void route();
    }
  });
  void route();
})();
