// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice 1,000-piece pixel character collection. Metadata stays hidden until reveal
/// so nobody can time a mint to snipe a legendary.
contract PixelFolk is ERC721, ERC2981, Ownable {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = 1000;

    uint256 public price;
    uint256 public maxPerWallet = 10;
    uint256 public totalSupply;
    bool public saleActive;
    bool public revealed;
    bool public metadataFrozen;
    /// sha256 of the final image set, published before the sale starts
    bytes32 public immutable provenance;
    string public hiddenURI;
    string private baseURI;

    mapping(address => uint256) public mintedBy;

    constructor(uint256 price_, string memory hiddenURI_, bytes32 provenance_, address royaltyReceiver)
        ERC721("Pixel Folk", "FOLK")
        Ownable(msg.sender)
    {
        price = price_;
        hiddenURI = hiddenURI_;
        provenance = provenance_;
        _setDefaultRoyalty(royaltyReceiver, 500); // 5%
    }

    function mint(uint256 quantity) external payable {
        require(saleActive, "sale not active");
        require(quantity > 0, "zero quantity");
        require(totalSupply + quantity <= MAX_SUPPLY, "exceeds supply");
        require(mintedBy[msg.sender] + quantity <= maxPerWallet, "wallet limit");
        require(msg.value == price * quantity, "wrong ETH amount");
        mintedBy[msg.sender] += quantity;
        _mintMany(msg.sender, quantity);
    }

    /// team, giveaways, collabs
    function ownerMint(address to, uint256 quantity) external onlyOwner {
        require(totalSupply + quantity <= MAX_SUPPLY, "exceeds supply");
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
        return string.concat(baseURI, tokenId.toString(), ".json");
    }

    // ---------------------------------------------------------------- owner

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
    }

    function setMaxPerWallet(uint256 max_) external onlyOwner {
        maxPerWallet = max_;
    }

    function setSaleActive(bool active) external onlyOwner {
        saleActive = active;
    }

    /// @param baseURI_ e.g. "ipfs://<metadataCID>/"
    function reveal(string calldata baseURI_) external onlyOwner {
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
