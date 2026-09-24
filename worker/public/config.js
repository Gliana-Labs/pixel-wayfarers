// Launch settings for the site. Each network has its own contract address; fill it after deploying
// contracts/src/PixelWayfarers.sol there. Visit /?network=sepolia to test the Sepolia deployment.
window.WAYFARERS = {
	network: "mainnet", // the network the public site uses
	networks: {
		mainnet: {
			contractAddress: "", // empty = mint box shows "Mint opens soon"
			chainId: 1,
			chainName: "Ethereum",
			rpcUrl: "https://ethereum-rpc.publicnode.com", // swap for an Alchemy URL before launch
			explorerUrl: "https://etherscan.io",
		},
		sepolia: {
			contractAddress: "",
			chainId: 11155111,
			chainName: "Sepolia",
			rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
			explorerUrl: "https://sepolia.etherscan.io",
		},
	},
	maxPerWallet: 20,
	xUrl: "https://x.com/pixelwayfarers",
	openseaUrl: "https://opensea.io/collection/pixel-wayfarers",
	provenance: "", // sha256 from `python pipeline/wayfarers.py provenance`
};
