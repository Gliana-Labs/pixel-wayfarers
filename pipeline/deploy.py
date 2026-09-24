"""Local deploy page: deploy PixelWayfarers through MetaMask (the key never leaves the wallet).

    python pipeline/deploy.py testnet     # then open http://localhost:8766

Prepare build/deploy/<network>.data first (creation bytecode + constructor args, see README).
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NETWORKS = {
    "testnet": {"chainId": 46630, "name": "Robinhood Chain Testnet",
                "rpc": "https://pixelwayfarers.com/api/rpc/testnet", "explorer": "https://explorer.testnet.chain.robinhood.com"},
    "mainnet": {"chainId": 4663, "name": "Robinhood Chain",
                "rpc": "https://pixelwayfarers.com/api/rpc/mainnet", "explorer": "https://robinhoodchain.blockscout.com"},
}
net_key = sys.argv[1] if len(sys.argv) > 1 else "testnet"
NET = NETWORKS[net_key]
DATA = (ROOT / "build" / "deploy" / f"{net_key}.data").read_text().strip()

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Deploy Pixel Wayfarers</title>
<style>body{font:16px system-ui;background:#16120e;color:#f2e6cf;max-width:640px;margin:60px auto;padding:0 16px}
h1{color:#f4b63f}button{font:600 16px system-ui;padding:12px 20px;background:#f4b63f;border:0;border-radius:6px;cursor:pointer}
button:disabled{opacity:.5}#log{margin-top:20px;white-space:pre-wrap;background:#221b14;padding:14px;border-radius:6px;min-height:80px}
a{color:#f4b63f}</style></head><body>
<h1>Deploy Pixel Wayfarers</h1>
<p>Network: <b>NETNAME</b> (chain CHAINID). MetaMask will ask you to add or switch networks, then to confirm the deploy.</p>
<button id="go">Deploy with MetaMask</button><div id="log"></div>
<script>
const NET=NETJSON, DATA="0x"+"BYTECODE".replace(/^0x/,"");
const log=m=>document.getElementById('log').innerHTML+=m+"\\n";
const hex="0x"+NET.chainId.toString(16);
document.getElementById('go').onclick=async e=>{
  e.target.disabled=true;
  try{
    if(!window.ethereum) throw new Error("MetaMask not found in this browser.");
    const [from]=await ethereum.request({method:"eth_requestAccounts"}); log("wallet: "+from);
    try{ await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:hex}]}); }
    catch(err){ if(err.code!==4902) throw err;
      await ethereum.request({method:"wallet_addEthereumChain",params:[{chainId:hex,chainName:NET.name,nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:[NET.rpc],blockExplorerUrls:[NET.explorer]}]}); }
    log("network ok, confirm the deploy in MetaMask...");
    const hash=await ethereum.request({method:"eth_sendTransaction",params:[{from,data:DATA}]});
    log('sent: <a target="_blank" href="'+NET.explorer+'/tx/'+hash+'">'+hash+'</a>');
    let r=null; for(let i=0;i<120&&!r;i++){ await new Promise(s=>setTimeout(s,2000));
      r=await fetch(NET.rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[hash]})}).then(x=>x.json()).then(x=>x.result).catch(()=>null); }
    if(!r) throw new Error("still pending, check the explorer link");
    if(r.status!=="0x1") throw new Error("deploy failed");
    log('\\nDEPLOYED at <b>'+r.contractAddress+'</b>\\n<a target="_blank" href="'+NET.explorer+'/address/'+r.contractAddress+'">view on explorer</a>');
    fetch("/deployed",{method:"POST",body:r.contractAddress});
  }catch(err){ log("error: "+(err.message||err)); e.target.disabled=false; }
};
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        page = (PAGE.replace("NETNAME", NET["name"]).replace("CHAINID", str(NET["chainId"]))
                .replace("NETJSON", json.dumps(NET)).replace("BYTECODE", DATA))
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(page.encode())

    def do_POST(self):
        addr = self.rfile.read(int(self.headers.get("content-length", 0))).decode().strip()
        (ROOT / "build" / "deploy" / f"{net_key}.address").write_text(addr + "\n")
        print(f"deployed at {addr}", flush=True)
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    print(f"deploy page for {NET['name']} on http://localhost:8766", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8766), H).serve_forever()
