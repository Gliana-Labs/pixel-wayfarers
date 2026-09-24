// Launch settings for the site. Each network has its own contract address; fill it after deploying
// contracts/src/PixelWayfarers.sol there. Visit /?network=testnet to test the testnet deployment.
// rpcUrl goes through our own relay (/api/rpc/...) because some ISPs block robinhood.com.
window.WAYFARERS = {
	network: "mainnet", // the network the public site uses
	networks: {
		mainnet: {
			contractAddress: "", // empty = mint box shows "Mint opens soon"
			chainId: 4663,
			chainName: "Robinhood Chain",
			rpcUrl: "https://pixelwayfarers.com/api/rpc/mainnet",
			explorerUrl: "https://robinhoodchain.blockscout.com",
		},
		testnet: {
			contractAddress: "",
			chainId: 46630,
			chainName: "Robinhood Chain Testnet",
			rpcUrl: "https://pixelwayfarers.com/api/rpc/testnet",
			explorerUrl: "https://explorer.testnet.chain.robinhood.com",
		},
	},
	maxPerWallet: 10,
	xUrl: "https://x.com/pixelwayfarers",
	openseaUrl: "https://opensea.io/collection/pixel-wayfarers",
	provenance: "", // sha256 from `python pipeline/wayfarers.py provenance`
};
