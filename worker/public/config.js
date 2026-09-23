// Launch settings for the site. Fill contractAddress after deploying contracts/src/PixelWayfarers.sol.
window.WAYFARERS = {
	contractAddress: "", // empty = mint panel shows "Mint opens soon"
	chainId: 8453, // Base mainnet (Base Sepolia testnet: 84532)
	chainName: "Base",
	rpcUrl: "https://mainnet.base.org",
	explorerUrl: "https://basescan.org",
	xUrl: "https://x.com/pixelwayfarers", // claim this handle before launch
	openseaUrl: "https://opensea.io/collection/pixel-wayfarers",
	provenance: "", // sha256 from `python pipeline/wayfarers.py provenance`
};
