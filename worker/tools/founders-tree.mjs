// Build the founders-list Merkle tree from approved wallets.
//   node tools/founders-tree.mjs ../build/founders-approved.txt [mainnet|testnet]
// Input: one wallet address per line. Output: ../build/founders-tree.json (root + proofs).
// Then: upload proofs for the site, and set the root in the contract (commands printed below).
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const network = process.argv[3] === "testnet" ? "testnet" : "mainnet";
const proofsKey = network === "testnet" ? "founders/proofs-testnet.json" : "founders/proofs.json";
if (!file) throw new Error("usage: node tools/founders-tree.mjs <approved-wallets.txt>");
const wallets = [...new Set(
	readFileSync(file, "utf8").split(/\s+/).map((w) => w.trim().toLowerCase()).filter(Boolean),
)];
const bad = wallets.filter((w) => !/^0x[0-9a-f]{40}$/.test(w));
if (bad.length) throw new Error(`not wallet addresses: ${bad.join(", ")}`);

// leaf = keccak256(bytes.concat(keccak256(abi.encode(address)))), what the contract checks
const tree = StandardMerkleTree.of(wallets.map((w) => [w]), ["address"]);
const proofs = {};
for (const [i, [w]] of tree.entries()) proofs[w] = tree.getProof(i);
writeFileSync(`../build/founders-proofs-${network}.json`, JSON.stringify(proofs));
console.log(`${wallets.length} wallets\nroot: ${tree.root}`);
console.log(`\n1) npx wrangler r2 object put pixel-wayfarers/${proofsKey} --file ../build/founders-proofs-${network}.json --content-type application/json --remote`);
console.log(`2) cast send <contract> "setAllowlist(bytes32,uint256)" ${tree.root} $(cast to-wei 0.002) --rpc-url robinhood --account deployer`);
