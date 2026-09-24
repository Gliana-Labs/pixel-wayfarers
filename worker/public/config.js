// Launch settings for the site. Each network has its own contract address; fill it after deploying
// contracts/src/PixelWayfarers.sol there. Visit /?network=testnet to test the testnet deployment.
// rpcUrl goes through our own relay (/api/rpc/...) so reads never depend on a visitor's ISP or rate limits.
window.WAYFARERS = {
	network: "mainnet", // the network the public site uses
	networks: {
		mainnet: {
			contractAddress: "", // empty = mint box shows "Mint opens soon"
			chainId: 1,
			chainName: "Ethereum",
			rpcUrl: "https://pixelwayfarers.com/api/rpc/mainnet",
			explorerUrl: "https://etherscan.io",
		},
		testnet: {
			contractAddress: "",
			chainId: 11155111,
			chainName: "Sepolia",
			rpcUrl: "https://pixelwayfarers.com/api/rpc/testnet",
			explorerUrl: "https://sepolia.etherscan.io",
		},
	},
	maxPerWallet: 10,
	xUrl: "https://x.com/pixelwayfarers",
	openseaUrl: "https://opensea.io/collection/pixel-wayfarers",
	provenance: "", // sha256 from `python pipeline/wayfarers.py provenance`
};
