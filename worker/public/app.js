(() => {
	const C = window.WAYFARERS;
	const $ = (s) => document.querySelector(s);
	const $$ = (s) => [...document.querySelectorAll(s)];
	const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

	// ---------------------------------------------------------------- links
	$$(".js-x").forEach((a) => (a.href = C.xUrl));
	$$(".js-opensea").forEach((a) => (a.href = C.openseaUrl));
	if (C.contractAddress) {
		const a = $(".js-contract");
		a.href = `${C.explorerUrl}/address/${C.contractAddress}`;
		a.hidden = false;
	}
	if (C.provenance) {
		const p = $(".js-provenance");
		p.querySelector("code").textContent = C.provenance;
		p.hidden = false;
	}

	// ---------------------------------------------------------------- notice board: one note open at a time
	// (browsers with <details name> do this natively; this covers the rest)
	$$(".faq-list details").forEach((d) =>
		d.addEventListener("toggle", () => {
			if (d.open) $$(".faq-list details").forEach((o) => o !== d && (o.open = false));
		}),
	);

	// ---------------------------------------------------------------- scroll reveal
	if (reduceMotion || !("IntersectionObserver" in window)) {
		$$(".reveal").forEach((el) => el.classList.add("in"));
	} else {
		const io = new IntersectionObserver(
			(entries) => entries.forEach((e) => {
				if (e.isIntersecting) {
					e.target.classList.add("in");
					io.unobserve(e.target);
				}
			}),
			{ threshold: 0.15 },
		);
		$$(".reveal").forEach((el) => io.observe(el));
	}

	// ---------------------------------------------------------------- traits
	const TIER_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3 };
	const tabs = $(".trait-tabs");
	const panel = $(".trait-panel");
	fetch("/traits.json")
		.then((r) => r.json())
		.then(({ traits }) => {
			const names = Object.keys(traits);
			const show = (name) => {
				tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.name === name)));
				panel.replaceChildren(
					...traits[name]
						.filter((o) => o.value !== "None")
						.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]) // stable: config order within a tier
						.map((o) => {
							const chip = document.createElement("div");
							chip.className = `chip ${o.tier}`;
							chip.textContent = o.value;
							const tier = document.createElement("small");
							tier.textContent = o.tier;
							chip.append(tier);
							return chip;
						}),
				);
			};
			names.forEach((name) => {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "trait-tab";
				b.role = "tab";
				b.dataset.name = name;
				b.textContent = name;
				const n = document.createElement("span");
				n.textContent = traits[name].filter((o) => o.value !== "None").length;
				b.append(n);
				b.addEventListener("click", () => show(name));
				tabs.append(b);
			});
			show(names[0]);
		})
		.catch(() => {
			panel.innerHTML = '<p class="trait-empty">Traits could not load. Refresh to try again.</p>';
		});

	// ---------------------------------------------------------------- mint
	const SEL = {
		mint: "0xa0712d68",
		price: "0xa035b1fe",
		totalSupply: "0x18160ddd",
		maxSupply: "0xd5abeb01",
		saleActive: "0x68428a1b",
	};
	const chainHex = "0x" + C.chainId.toString(16);
	const btn = $(".js-mint");
	const status = $(".js-status");
	const qtyOut = $(".js-qty");
	const state = { qty: 1, price: null, supply: null, max: 1000, active: false, account: null, busy: false };

	const setStatus = (html, kind = "") => {
		status.className = `mint-status js-status ${kind}`;
		status.innerHTML = html;
	};
	const formatEth = (wei) => {
		const s = (Number(wei) / 1e18).toFixed(5);
		return s.replace(/\.?0+$/, "");
	};
	const rpc = async (method, params) => {
		const res = await fetch(C.rpcUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		const body = await res.json();
		if (body.error) throw new Error(body.error.message);
		return body.result;
	};
	const call = (data) => rpc("eth_call", [{ to: C.contractAddress, data }, "latest"]).then((h) => BigInt(h));

	$(".js-minus").addEventListener("click", () => setQty(state.qty - 1));
	$(".js-plus").addEventListener("click", () => setQty(state.qty + 1));
	function setQty(q) {
		state.qty = Math.max(1, Math.min(10, q));
		qtyOut.textContent = state.qty;
		render();
	}

	async function refresh() {
		if (!C.contractAddress) return render();
		try {
			const [price, supply, max, active] = await Promise.all([
				call(SEL.price), call(SEL.totalSupply), call(SEL.maxSupply), call(SEL.saleActive),
			]);
			Object.assign(state, { price, supply: Number(supply), max: Number(max), active: active === 1n });
		} catch {
			setStatus(`Could not reach ${C.chainName}. Retrying...`, "err");
		}
		render();
	}

	function render() {
		if (state.busy) return;
		const supplyEl = $(".js-supply");
		const priceEl = $(".js-price");
		if (state.supply !== null) supplyEl.textContent = `${state.supply.toLocaleString()} / ${state.max.toLocaleString()}`;
		if (state.price !== null) priceEl.textContent = `${formatEth(state.price)} ETH`;

		btn.disabled = false;
		if (!C.contractAddress || (!state.active && state.supply !== state.max)) {
			btn.disabled = true;
			btn.textContent = "Mint opens soon";
			if (!status.classList.contains("ok")) setStatus("The mint date will be announced on X.");
			return;
		}
		if (state.supply >= state.max) {
			btn.disabled = true;
			btn.textContent = "Sold out";
			setStatus(`All ${state.max.toLocaleString()} are out. Find one on <a href="${C.openseaUrl}" target="_blank" rel="noopener">OpenSea</a>.`);
			return;
		}
		if (!window.ethereum) {
			btn.textContent = "Connect wallet";
			return;
		}
		if (!state.account) {
			btn.innerHTML = '<i class="ph-bold ph-wallet" aria-hidden="true"></i>Connect wallet';
			return;
		}
		const total = state.price * BigInt(state.qty);
		btn.textContent = `Mint ${state.qty} for ${formatEth(total)} ETH`;
	}

	async function onClick() {
		if (!window.ethereum) {
			setStatus("No wallet found. Install Coinbase Wallet or MetaMask, then reload this page.", "err");
			return;
		}
		try {
			if (!state.account) {
				const [account] = await ethereum.request({ method: "eth_requestAccounts" });
				state.account = account;
				setStatus("Wallet connected.");
				return render();
			}
			await ensureChain();
			await mint();
		} catch (err) {
			state.busy = false;
			const msg = err?.code === 4001 ? "Request cancelled in your wallet." : (err?.shortMessage || err?.message || "Something went wrong.");
			setStatus(msg.slice(0, 160), "err");
			render();
		}
	}

	async function ensureChain() {
		const current = await ethereum.request({ method: "eth_chainId" });
		if (current === chainHex) return;
		setStatus(`Switching your wallet to ${C.chainName}...`);
		try {
			await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
		} catch (err) {
			if (err?.code !== 4902) throw err;
			await ethereum.request({
				method: "wallet_addEthereumChain",
				params: [{
					chainId: chainHex,
					chainName: C.chainName,
					nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
					rpcUrls: [C.rpcUrl],
					blockExplorerUrls: [C.explorerUrl],
				}],
			});
		}
	}

	async function mint() {
		await refresh();
		if (!state.active) throw new Error("The sale is not active right now.");
		state.busy = true;
		btn.disabled = true;
		btn.textContent = "Confirm in wallet";
		setStatus("Check your wallet to confirm the mint.");
		const value = state.price * BigInt(state.qty);
		const data = SEL.mint + state.qty.toString(16).padStart(64, "0");
		const hash = await ethereum.request({
			method: "eth_sendTransaction",
			params: [{ from: state.account, to: C.contractAddress, data, value: "0x" + value.toString(16) }],
		});
		btn.innerHTML = '<i class="ph-bold ph-circle-notch spin" aria-hidden="true"></i>Minting';
		setStatus(`Transaction sent. <a href="${C.explorerUrl}/tx/${hash}" target="_blank" rel="noopener">View it</a>.`);
		let receipt = null;
		for (let i = 0; i < 90 && !receipt; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			receipt = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
		}
		state.busy = false;
		if (!receipt) throw new Error("Still pending. Check the transaction link above.");
		if (receipt.status !== "0x1") throw new Error("The mint transaction failed. No ETH was taken beyond gas.");
		setStatus(`Minted ${state.qty}! Your wayfarers reveal after the sale. <a href="${C.explorerUrl}/tx/${hash}" target="_blank" rel="noopener">Receipt</a>.`, "ok");
		await refresh();
	}

	btn.addEventListener("click", onClick);
	if (window.ethereum) {
		ethereum.request({ method: "eth_accounts" }).then(([a]) => { state.account = a || null; render(); }).catch(() => {});
		ethereum.on?.("accountsChanged", ([a]) => { state.account = a || null; render(); });
		ethereum.on?.("chainChanged", () => render());
	}
	refresh();
	if (C.contractAddress) setInterval(refresh, 20000);
})();
