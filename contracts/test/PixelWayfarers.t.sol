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

        nft.setSaleActive(false);
        nft.setStartingIndex();
        nft.reveal("ipfs://meta/");
        uint256 expected = ((2 - 1 + nft.startingIndex()) % nft.maxSupply()) + 1;
        assertEq(nft.tokenURI(2), string.concat("ipfs://meta/", vm.toString(expected), ".json"));
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
        nft.mint{value: PRICE * 10}(10);
        vm.prank(buyer);
        vm.expectRevert("wallet limit");
        nft.mint{value: PRICE}(1);
    }

    function test_supplyCap() public {
        nft.ownerMint(address(this), 1000);
        nft.setSaleActive(true);
        vm.prank(buyer);
        vm.expectRevert("exceeds supply");
        nft.mint{value: PRICE}(1);
    }

    function test_freezeBlocksReveal() public {
        nft.setStartingIndex();
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

    function test_revealNeedsStartingIndex() public {
        vm.expectRevert("draw startingIndex first");
        nft.reveal("ipfs://meta/");
    }

    function test_startingIndexOnlyOnceAndAfterSale() public {
        nft.setSaleActive(true);
        vm.expectRevert("stop the sale first");
        nft.setStartingIndex();
        nft.setSaleActive(false);
        vm.prevrandao(bytes32(uint256(424242)));
        nft.setStartingIndex();
        assertLt(nft.startingIndex(), nft.maxSupply());
        vm.expectRevert("already set");
        nft.setStartingIndex();
        vm.expectRevert("offset already drawn");
        nft.cutSupply(10);
    }

    function test_offsetMapsEveryTokenToUniqueArt() public {
        nft.ownerMint(address(this), 1000);
        vm.prevrandao(bytes32(uint256(7)));
        nft.setStartingIndex();
        nft.reveal("x/");
        // wrap-around: the last token maps back into range, never 0 or 1001
        uint256 last = ((1000 - 1 + nft.startingIndex()) % 1000) + 1;
        assertEq(nft.tokenURI(1000), string.concat("x/", vm.toString(last), ".json"));
        assertGe(last, 1);
        assertLe(last, 1000);
    }

    function test_contractURI() public {
        assertEq(nft.contractURI(), "https://example.com/collection.json");
        nft.setContractURI("https://pixelfolk.xyz/collection.json");
        assertEq(nft.contractURI(), "https://pixelfolk.xyz/collection.json");
    }

    receive() external payable {}
}
