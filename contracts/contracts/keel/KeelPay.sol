// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title KeelPay
/// @notice Escrowed MUSD "claim links": send MUSD to someone who has no wallet yet.
///
/// How it works
///  1. The sender's app generates an ephemeral key pair. The *address* is registered on-chain with the
///     amount and an expiry; the *private key* only ever lives in the link that is sent to the recipient.
///  2. The recipient opens the link, picks (or creates) a wallet, and signs an EIP-712 `Claim(link, to)`
///     message with the ephemeral key. Anyone (the Keel bot, gaslessly) can relay it.
///  3. Because the signature binds `to`, a relayer or mempool observer cannot redirect the funds.
///  4. Unclaimed links can be cancelled by the sender at any time, and always refund after expiry.
contract KeelPay is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(address link,address to)");

    IERC20 public immutable token;

    struct Link {
        address sender;
        uint96 amount;
        uint64 expiry;
        bool settled;
    }

    mapping(address => Link) public links; // key = ephemeral link address

    event LinkCreated(address indexed link, address indexed sender, uint256 amount, uint64 expiry);
    event LinkClaimed(address indexed link, address indexed to, uint256 amount, address relayer);
    event LinkCancelled(address indexed link, address indexed sender, uint256 amount);

    error LinkExists();
    error LinkUnknown();
    error LinkSettled();
    error BadParams();
    error BadSignature();
    error Expired();
    error NotSender();

    constructor(IERC20 token_) EIP712("KeelPay", "1") {
        token = token_;
    }

    /// @notice Create a claim link funded by the caller (needs prior approval).
    function create(address link, uint256 amount, uint64 expiry) external nonReentrant {
        _create(link, amount, expiry);
    }

    /// @notice Create a claim link using an EIP-2612 permit so the sender only signs once.
    function createWithPermit(
        address link,
        uint256 amount,
        uint64 expiry,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // A front-run permit would only make this call revert later on allowance; ignore its failure.
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, permitDeadline, v, r, s) {} catch {}
        _create(link, amount, expiry);
    }

    /// @notice Claim with a signature produced by the ephemeral link key. Callable by anyone (relayers).
    function claim(address link, address to, bytes calldata signature) external nonReentrant {
        Link storage l = links[link];
        if (l.sender == address(0)) revert LinkUnknown();
        if (l.settled) revert LinkSettled();
        if (block.timestamp > l.expiry) revert Expired();
        if (to == address(0)) revert BadParams();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, link, to)));
        if (ECDSA.recover(digest, signature) != link) revert BadSignature();

        l.settled = true;
        uint256 amount = l.amount;
        token.safeTransfer(to, amount);
        emit LinkClaimed(link, to, amount, msg.sender);
    }

    /// @notice Sender can cancel an unclaimed link at any time (or after expiry, anyone can trigger the refund).
    function cancel(address link) external nonReentrant {
        Link storage l = links[link];
        if (l.sender == address(0)) revert LinkUnknown();
        if (l.settled) revert LinkSettled();
        if (msg.sender != l.sender && block.timestamp <= l.expiry) revert NotSender();

        l.settled = true;
        uint256 amount = l.amount;
        token.safeTransfer(l.sender, amount);
        emit LinkCancelled(link, l.sender, amount);
    }

    function claimDigest(address link, address to) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, link, to)));
    }

    function _create(address link, uint256 amount, uint64 expiry) internal {
        if (link == address(0) || amount == 0 || amount > type(uint96).max || expiry <= block.timestamp) {
            revert BadParams();
        }
        if (links[link].sender != address(0)) revert LinkExists();
        links[link] = Link({sender: msg.sender, amount: uint96(amount), expiry: expiry, settled: false});
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit LinkCreated(link, msg.sender, amount, expiry);
    }
}
