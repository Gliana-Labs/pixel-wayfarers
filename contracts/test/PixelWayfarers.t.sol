// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PixelWayfarers} from "../src/PixelWayfarers.sol";

contract PixelWayfarersTest is Test {
    PixelWayfarers nft;
    address buyer = address(0xB0B);
    uint256 constant PRICE = 0.003 ether;

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
        nft.mint{value: PRICE * 20}(20);
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

    // --- founders list: a 2-leaf tree built by hand, same leaf format as the site uses
    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _setupList(address x, address y) internal returns (bytes32[] memory proofX) {
        bytes32 lx = _leaf(x);
        bytes32 ly = _leaf(y);
        bytes32 root = lx < ly ? keccak256(abi.encodePacked(lx, ly)) : keccak256(abi.encodePacked(ly, lx));
        nft.setAllowlist(root, 0.002 ether);
        proofX = new bytes32[](1);
        proofX[0] = ly;
    }

    function test_allowlistMint() public {
        address friend = address(0xF00D);
        bytes32[] memory proof = _setupList(buyer, friend);
        vm.prank(buyer);
        vm.expectRevert("founders list not active");
        nft.allowlistMint{value: 0.002 ether}(1, proof);
        nft.setAllowlistActive(true);
        vm.prank(buyer);
        nft.allowlistMint{value: 0.004 ether}(2, proof);
        assertEq(nft.balanceOf(buyer), 2);
        vm.prank(buyer);
        vm.expectRevert("wrong ETH amount");
        nft.allowlistMint{value: PRICE}(1, proof); // list price, not public price
    }

    function test_allowlistRejectsOutsiders() public {
        bytes32[] memory proof = _setupList(buyer, address(0xF00D));
        nft.setAllowlistActive(true);
        address stranger = address(0xBAD);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert("not on founders list");
        nft.allowlistMint{value: 0.002 ether}(1, proof);
    }

    function test_foundersCapIsHigher() public {
        bytes32[] memory proof = _setupList(buyer, address(0xF00D));
        nft.setAllowlistActive(true);
        vm.prank(buyer);
        nft.allowlistMint{value: 0.002 ether * 50}(50, proof);
        vm.prank(buyer);
        vm.expectRevert("wallet limit");
        nft.allowlistMint{value: 0.002 ether}(1, proof);
        nft.setAllowlistActive(false);
        nft.setSaleActive(true);
        vm.prank(buyer);
        vm.expectRevert("wallet limit");
        nft.mint{value: PRICE}(1);
    }

    function test_walletCapSharedAcrossPhases() public {
        bytes32[] memory proof = _setupList(buyer, address(0xF00D));
        nft.setAllowlistActive(true);
        vm.prank(buyer);
        nft.allowlistMint{value: 0.002 ether * 18}(18, proof);
        nft.setAllowlistActive(false);
        nft.setSaleActive(true);
        vm.prank(buyer);
        vm.expectRevert("wallet limit");
        nft.mint{value: PRICE * 3}(3);
        vm.prank(buyer);
        nft.mint{value: PRICE * 2}(2);
        assertEq(nft.balanceOf(buyer), 20);
    }

    function test_contractURI() public {
        assertEq(nft.contractURI(), "https://example.com/collection.json");
        nft.setContractURI("https://pixelfolk.xyz/collection.json");
        assertEq(nft.contractURI(), "https://pixelfolk.xyz/collection.json");
    }

    // proof produced by tools/founders-tree.mjs (OpenZeppelin StandardMerkleTree) must verify on-chain
    function test_jsTreeProofVerifies() public {
        nft.setAllowlist(0xb460829d1c57b7ff739a8f7474e7eac700333e20ec95fcf7899f681388ddb94a, 0.002 ether);
        nft.setAllowlistActive(true);
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0x4eebe1b384216e25ce96493028fe56ca98233900701da20c64963fd48ba3e63f;
        proof[1] = 0xd1cfdef7893d0666c4cac8eda35c2e6308a6cd7e95feb2150db1c631cc4ada67;
        vm.prank(buyer);
        nft.allowlistMint{value: 0.002 ether}(1, proof);
        assertEq(nft.balanceOf(buyer), 1);
    }

    receive() external payable {}
}
