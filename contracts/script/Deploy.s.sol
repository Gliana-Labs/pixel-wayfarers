// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PixelWayfarers} from "../src/PixelWayfarers.sol";

/// forge script script/Deploy.s.sol --rpc-url sepolia --account deployer --broadcast
contract Deploy is Script {
    function run() external {
        uint256 price = vm.envUint("PRICE_WEI"); // 0.004 ether
        string memory hiddenURI = vm.envString("HIDDEN_URI");
        string memory contractURI = vm.envOr("CONTRACT_URI", string("https://pixelwayfarers.com/collection.json"));
        bytes32 provenance = vm.envBytes32("PROVENANCE");
        address royaltyReceiver = vm.envAddress("ROYALTY_RECEIVER");

        vm.startBroadcast();
        PixelWayfarers nft = new PixelWayfarers(price, hiddenURI, contractURI, provenance, royaltyReceiver);
        vm.stopBroadcast();

        console.log("PixelWayfarers deployed at", address(nft));
    }
}
