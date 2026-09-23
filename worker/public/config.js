// Launch settings for the site. Fill contractAddress after deploying contracts/src/PixelWayfarers.sol.
window.WAYFARERS = {
	contractAddress: "", // empty = mint panel shows "Mint opens soon"
	chainId: 1, // Ethereum mainnet (Sepolia testnet: 11155111)
	chainName: "Ethereum",
	rpcUrl: "https://ethereum-rpc.publicnode.com", // swap for an Alchemy/Infura URL at launch
	explorerUrl: "https://etherscan.io",
	xUrl: "https://x.com/pixelwayfarers", // claim this handle before launch
	openseaUrl: "https://opensea.io/collection/pixel-wayfarers",
	provenance: "", // sha256 from `python pipeline/wayfarers.py provenance`
};
