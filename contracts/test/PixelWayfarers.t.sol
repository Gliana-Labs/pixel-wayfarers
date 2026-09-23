// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PixelWayfarers} from "../src/PixelWayfarers.sol";

contract PixelWayfarersTest is Test {
    PixelWayfarers nft;
    address buyer = address(0xB0B);
    uint256 constant PRICE = 0.004 ether;

    function setUp() public {
        nft = new PixelWayfarers(
            PRICE, "ipfs://hidden/hidden.json", "https://example.com/collection.json", bytes32(uint256(1)), address(this)
        );
        vm.deal(buyer, 10 ether);
    }

    function test_mintRequiresActiveSale() public {
        vm.prank(buyer);
        vm.expectRevert("sale not active");
        nft.mint{value: PRICE}(1);
    }

    function test_mintAndHiddenThenReveal() public {
        nft.setSaleActive(true);
        vm.prank(buyer);
        nft.mint{value: PRICE * 3}(3);
        assertEq(nft.ownerOf(3), buyer);
        assertEq(nft.tokenURI(1), "ipfs://hidden/hidden.json");

        nft.reveal("ipfs://meta/");
        assertEq(nft.tokenURI(2), "ipfs://meta/2.json");
    }

    function test_wrongValueReverts() public {
        nft.setSaleActive(true);
        vm.prank(buyer);
        vm.expectRevert("wrong ETH amount");
        nft.mint{value: PRICE}(2);
    }

    function test_walletLimit() public {
        nft.setSaleActive(true);
        vm.prank(buyer);
        vm.expectRevert("wallet limit");
        nft.mint{value: PRICE * 11}(11);
    }

    function test_supplyCap() public {
        nft.ownerMint(address(this), 1000);
        nft.setSaleActive(true);
        vm.prank(buyer);
        vm.expectRevert("exceeds supply");
        nft.mint{value: PRICE}(1);
    }

    function test_freezeBlocksReveal() public {
        nft.reveal("ipfs://meta/");
        nft.freezeMetadata();
        vm.expectRevert("metadata frozen");
        nft.reveal("ipfs://other/");
    }

    function test_withdraw() public {
        nft.setSaleActive(true);
        vm.prank(buyer);
        nft.mint{value: PRICE}(1);
        uint256 before = address(this).balance;
        nft.withdraw();
        assertEq(address(this).balance, before + PRICE);
    }

    function test_cutSupply() public {
        nft.setSaleActive(true);
        vm.prank(buyer);
        nft.mint{value: PRICE * 3}(3);
        vm.expectRevert("below minted");
        nft.cutSupply(2);
        nft.cutSupply(3);
        assertEq(nft.maxSupply(), 3);
        vm.expectRevert("can only lower");
        nft.cutSupply(500);
        vm.prank(buyer);
        vm.expectRevert("exceeds supply");
        nft.mint{value: PRICE}(1);
    }

    function test_contractURI() public {
        assertEq(nft.contractURI(), "https://example.com/collection.json");
        nft.setContractURI("https://pixelfolk.xyz/collection.json");
        assertEq(nft.contractURI(), "https://pixelfolk.xyz/collection.json");
    }

    receive() external payable {}
}
