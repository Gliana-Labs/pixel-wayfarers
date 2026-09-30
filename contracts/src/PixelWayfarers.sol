// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice 1,000-piece pixel character collection. Metadata stays hidden until reveal
/// so nobody can time a mint to snipe a legendary.
contract PixelWayfarers is ERC721, ERC2981, Ownable {
    using Strings for uint256;

    /// starts at 1000; the owner can only ever lower it (e.g. end the sale at what sold)
    uint256 public maxSupply = 1000;

    uint256 public price;
    /// Founders list (phase 1): cheaper, only wallets in the Merkle tree, higher per-wallet cap.
    uint256 public allowlistPrice;
    bytes32 public merkleRoot;
    bool public allowlistActive;
    /// Both caps count everything a wallet minted in either phase.
    uint256 public maxPerWallet = 20;
    uint256 public allowlistMaxPerWallet = 50;
    uint256 public totalSupply;
    bool public saleActive;
    bool public revealed;
    bool public metadataFrozen;
    /// sha256 of the final image set, published before the sale starts
    bytes32 public immutable provenance;
    string public hiddenURI;
    string private baseURI;
    /// collection-level metadata for marketplaces (ERC-7572), served over HTTPS
    string private _contractURI;
    /// Random shift between token ids and art, drawn after the sale so nobody (the team included)
    /// knows in advance which token id gets which art. Art file = ((tokenId - 1 + startingIndex) % maxSupply) + 1.
    uint256 public startingIndex;
    bool public startingIndexSet;

    event ContractURIUpdated();
    event StartingIndexSet(uint256 startingIndex);

    mapping(address => uint256) public mintedBy;

    constructor(
        uint256 price_,
        string memory hiddenURI_,
        string memory contractURI_,
        bytes32 provenance_,
        address royaltyReceiver
    )
        ERC721("Pixel Wayfarers", "WAYFR")
        Ownable(msg.sender)
    {
        price = price_;
        hiddenURI = hiddenURI_;
        _contractURI = contractURI_;
        provenance = provenance_;
        _setDefaultRoyalty(royaltyReceiver, 500); // 5%
    }

    function mint(uint256 quantity) external payable {
        require(saleActive, "sale not active");
        _paidMint(quantity, price, maxPerWallet);
    }

    /// Phase 1. `proof` comes from the site; leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet)))),
    /// the OpenZeppelin StandardMerkleTree format.
    function allowlistMint(uint256 quantity, bytes32[] calldata proof) external payable {
        require(allowlistActive, "founders list not active");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
        require(MerkleProof.verifyCalldata(proof, merkleRoot, leaf), "not on founders list");
        _paidMint(quantity, allowlistPrice, allowlistMaxPerWallet);
    }

    function _paidMint(uint256 quantity, uint256 unitPrice, uint256 cap) private {
        require(quantity > 0, "zero quantity");
        require(totalSupply + quantity <= maxSupply, "exceeds supply");
        require(mintedBy[msg.sender] + quantity <= cap, "wallet limit");
        require(msg.value == unitPrice * quantity, "wrong ETH amount");
        mintedBy[msg.sender] += quantity;
        _mintMany(msg.sender, quantity);
    }

    /// team, giveaways, collabs
    function ownerMint(address to, uint256 quantity) external onlyOwner {
        require(totalSupply + quantity <= maxSupply, "exceeds supply");
        _mintMany(to, quantity);
    }

    // _mint (not _safeMint) so no receiver callback can re-enter mid-loop
    function _mintMany(address to, uint256 quantity) private {
        uint256 next = totalSupply;
        totalSupply = next + quantity;
        for (uint256 i = 1; i <= quantity; ++i) {
            _mint(to, next + i);
        }
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (!revealed) return hiddenURI;
        uint256 artId = ((tokenId - 1 + startingIndex) % maxSupply) + 1;
        return string.concat(baseURI, artId.toString(), ".json");
    }

    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    // ---------------------------------------------------------------- owner

    function setContractURI(string calldata uri) external onlyOwner {
        _contractURI = uri;
        emit ContractURIUpdated();
    }

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
    }

    function setMaxPerWallet(uint256 max_) external onlyOwner {
        maxPerWallet = max_;
    }

    function setAllowlistMaxPerWallet(uint256 max_) external onlyOwner {
        allowlistMaxPerWallet = max_;
    }

    /// Shrink the collection, never grow it. Setting it to totalSupply closes the mint for good.
    function cutSupply(uint256 newMax) external onlyOwner {
        require(!startingIndexSet, "offset already drawn");
        require(newMax < maxSupply, "can only lower");
        require(newMax >= totalSupply, "below minted");
        maxSupply = newMax;
    }

    function setSaleActive(bool active) external onlyOwner {
        saleActive = active;
    }

    function setAllowlist(bytes32 root, uint256 price_) external onlyOwner {
        merkleRoot = root;
        allowlistPrice = price_;
    }

    function setAllowlistActive(bool active) external onlyOwner {
        allowlistActive = active;
    }

    /// Draw the random offset once the sale is over (and supply is final). One time only.
    function setStartingIndex() external onlyOwner {
        require(!startingIndexSet, "already set");
        require(!saleActive && !allowlistActive, "stop the sale first");
        startingIndex = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), totalSupply))) % maxSupply;
        startingIndexSet = true;
        emit StartingIndexSet(startingIndex);
    }

    /// @param baseURI_ e.g. "ipfs://<metadataCID>/"
    function reveal(string calldata baseURI_) external onlyOwner {
        require(startingIndexSet, "draw startingIndex first");
        require(!metadataFrozen, "metadata frozen");
        baseURI = baseURI_;
        revealed = true;
    }

    /// one-way: after this nobody (including owner) can change the art
    function freezeMetadata() external onlyOwner {
        require(revealed, "not revealed");
        metadataFrozen = true;
    }

    function setRoyalty(address receiver, uint96 feeBps) external onlyOwner {
        _setDefaultRoyalty(receiver, feeBps);
    }

    function withdraw() external onlyOwner {
        (bool ok,) = payable(owner()).call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
