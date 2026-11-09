/** Code-only upgrade of the collection (state kept): npx tsx scripts/redeploy.ts. Key from ~/.near-gliana. */
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
await new Account(COLLECTION, p, new KeyPairSigner(KeyPair.fromString(key))).deployContract(readFileSync('collection/target/near/wayfarers.wasm'));
await new Promise((r) => setTimeout(r, 3000));
const cfg = (await p.callFunction(COLLECTION, 'config', {})) as { items: number; item_price: string };
console.log(`redeployed ${COLLECTION}: ${cfg.items} items, item price ${cfg.item_price}`);
