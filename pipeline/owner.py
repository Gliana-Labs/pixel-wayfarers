"""Local owner console: run contract owner actions through MetaMask (the key never leaves the wallet).

    python pipeline/owner.py testnet      # then open http://localhost:8767

Reads the contract address from build/deploy/<network>.address. Calldata is built with `cast`
(Foundry) on this machine; MetaMask signs and sends.
"""
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAST = str(Path.home() / ".foundry" / "bin" / "cast")
NETWORKS = {
    "testnet": {"chainId": 46630, "name": "Robinhood Chain Testnet",
                "rpc": "https://pixelwayfarers.com/api/rpc/testnet", "explorer": "https://explorer.testnet.chain.robinhood.com"},
    "mainnet": {"chainId": 4663, "name": "Robinhood Chain",
                "rpc": "https://pixelwayfarers.com/api/rpc/mainnet", "explorer": "https://robinhoodchain.blockscout.com"},
}
net_key = sys.argv[1] if len(sys.argv) > 1 else "testnet"
NET = NETWORKS[net_key]
ADDR = (ROOT / "build" / "deploy" / f"{net_key}.address").read_text().strip()

# label, function signature, argument placeholders (empty list = no inputs)
ACTIONS = [
    ("Set founders list", "setAllowlist(bytes32,uint256)", ["merkle root 0x...", "price in wei (0.003 ETH = 3000000000000000)"]),
    ("Founders phase ON", "setAllowlistActive(bool)", ["true"]),
    ("Founders phase OFF", "setAllowlistActive(bool)", ["false"]),
    ("Public sale ON", "setSaleActive(bool)", ["true"]),
    ("Public sale OFF", "setSaleActive(bool)", ["false"]),
    ("Set public price", "setPrice(uint256)", ["price in wei (0.004 ETH = 4000000000000000)"]),
    ("Owner mint (giveaways)", "ownerMint(address,uint256)", ["to address 0x...", "quantity"]),
    ("Close sale at what sold", "cutSupply(uint256)", ["new max supply (usually = minted)"]),
    ("Draw random offset", "setStartingIndex()", []),
    ("Reveal", "reveal(string)", ["ipfs://METADATA_CID/"]),
    ("Freeze metadata (forever)", "freezeMetadata()", []),
    ("Withdraw ETH to owner", "withdraw()", []),
]
READS = ["owner()(address)", "totalSupply()(uint256)", "maxSupply()(uint256)", "price()(uint256)",
         "allowlistPrice()(uint256)", "merkleRoot()(bytes32)", "allowlistActive()(bool)", "saleActive()(bool)",
         "startingIndexSet()(bool)", "revealed()(bool)", "metadataFrozen()(bool)"]


def cast(*args):
    out = subprocess.run([CAST, *args], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise ValueError(out.stderr.strip().splitlines()[-1] if out.stderr else "cast failed")
    return out.stdout.strip()


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Owner console</title>
<style>body{font:15px system-ui;background:#16120e;color:#f2e6cf;max-width:760px;margin:40px auto;padding:0 16px}
h1{color:#f4b63f;margin-bottom:4px}.sub{color:#b9a88a;margin-top:0}table{width:100%;border-collapse:collapse;margin:14px 0 24px}
td{padding:4px 8px;border-bottom:1px solid #3b2e22;font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}
.act{background:#221b14;border:1px solid #3b2e22;border-radius:6px;padding:12px;margin:10px 0}
.act b{color:#f4b63f}input{width:100%;box-sizing:border-box;margin:6px 0;padding:8px;background:#0f0c09;color:#f2e6cf;border:1px solid #3b2e22;border-radius:4px;font:13px ui-monospace,monospace}
button{font:600 14px system-ui;padding:8px 14px;background:#f4b63f;border:0;border-radius:5px;cursor:pointer;margin-top:4px}
#log{white-space:pre-wrap;background:#0f0c09;padding:12px;border-radius:6px;min-height:60px;font:13px ui-monospace,monospace}a{color:#f4b63f}</style>
</head><body><h1>Owner console</h1><p class="sub">__NETNAME__ &middot; contract __ADDR__</p>
<button onclick="state()">Refresh state</button><table id="state"></table><div id="log"></div><div id="acts"></div>
<script>
const NET=__NET__, ADDR="__ADDR__", ACTIONS=__ACTIONS__; const hex="0x"+NET.chainId.toString(16);
const log=m=>{document.getElementById('log').innerHTML=m;};
// several wallet extensions fight over window.ethereum; ask each by name (EIP-6963) and prefer MetaMask
let W=window.ethereum; const WALLETS=[];
window.addEventListener('eip6963:announceProvider',e=>{WALLETS.push(e.detail);const mm=WALLETS.find(w=>w.info.rdns==='io.metamask');W=(mm||WALLETS[0]).provider;});
window.dispatchEvent(new Event('eip6963:requestProvider'));
async function state(){ const r=await fetch('/state').then(x=>x.json());
  document.getElementById('state').innerHTML=Object.entries(r).map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join(''); }
document.getElementById('acts').innerHTML=ACTIONS.map(([label,sig,ph],i)=>`<div class="act"><b>${label}</b> <code>${sig}</code>
  ${ph.map((p,j)=>`<input id="a${i}_${j}" placeholder="${p}" ${p==='true'||p==='false'?`value="${p}" readonly`:''}>`).join('')}
  <br><button onclick="run(${i})">Send with MetaMask</button></div>`).join('');
async function run(i){
  try{ const [label,sig,ph]=ACTIONS[i]; const args=ph.map((_,j)=>document.getElementById(`a${i}_${j}`).value.trim());
    if(label.startsWith('Freeze')&&!confirm('Freeze is permanent. Continue?')) return;
    const cd=await fetch('/calldata',{method:'POST',body:JSON.stringify({sig,args})}).then(x=>x.json());
    if(cd.error) throw new Error(cd.error);
    const [from]=await W.request({method:'eth_requestAccounts'});
    try{ await W.request({method:'wallet_switchEthereumChain',params:[{chainId:hex}]}); }
    catch(err){ if(err.code!==4902) throw err; await W.request({method:'wallet_addEthereumChain',params:[{chainId:hex,chainName:NET.name,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[NET.rpc],blockExplorerUrls:[NET.explorer]}]}); }
    log(label+': confirm in MetaMask...');
    const hash=await W.request({method:'eth_sendTransaction',params:[{from,to:ADDR,data:cd.data}]});
    log(label+': sent <a target="_blank" href="'+NET.explorer+'/tx/'+hash+'">'+hash+'</a>, waiting...');
    let r=null; for(let k=0;k<90&&!r;k++){ await new Promise(s=>setTimeout(s,2000));
      r=await fetch(NET.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getTransactionReceipt',params:[hash]})}).then(x=>x.json()).then(x=>x.result).catch(()=>null); }
    log(label+': '+(r?(r.status==='0x1'?'done ✅':'FAILED (reverted)'):'still pending')+' <a target="_blank" href="'+NET.explorer+'/tx/'+hash+'">tx</a>'); state();
  }catch(e){ log('error: '+(e.message||e)); } }
state();
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.end_headers()
        self.wfile.write(body.encode())

    def do_GET(self):
        if self.path == "/state":
            out = {}
            for sig in READS:
                try:
                    out[sig.split("(")[0]] = cast("call", ADDR, sig, "--rpc-url", NET["rpc"])
                except ValueError as e:
                    out[sig.split("(")[0]] = f"error: {e}"
            out["balance (ETH)"] = cast("balance", ADDR, "--ether", "--rpc-url", NET["rpc"])
            return self.send(200, json.dumps(out))
        page = (PAGE.replace("__NETNAME__", NET["name"]).replace("__NET__", json.dumps(NET))
                .replace("__ACTIONS__", json.dumps(ACTIONS)).replace("__ADDR__", ADDR))
        self.send(200, page, "text/html; charset=utf-8")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        sig = body.get("sig")
        if sig not in {a[1] for a in ACTIONS}:
            return self.send(400, json.dumps({"error": "unknown action"}))
        try:
            data = cast("calldata", sig, *body.get("args", []))
        except ValueError as e:
            return self.send(400, json.dumps({"error": f"bad arguments: {e}"}))
        self.send(200, json.dumps({"data": data}))


if __name__ == "__main__":
    print(f"owner console for {NET['name']} ({ADDR}) on http://localhost:8767", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8767), H).serve_forever()
