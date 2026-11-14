// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./KeelGuardianV2.sol";

/// @title KeelGuardianFactoryV2
/// @notice Deploys one deterministic KeelGuardianV2 clone per user. The implementation is immutable. The only admin
///         setting is where the protocol share of keeper tips goes and how big that share is, hard-capped at
///         MAX_PROTOCOL_SHARE_BPS of the tip (the tip itself is capped at 1% of the amount applied, in the guardian).
///         The admin can't touch any guardian, loan, reserve or configuration.
contract KeelGuardianFactoryV2 {
    uint256 public constant MAX_PROTOCOL_SHARE_BPS = 5_000; // half of the keeper tip, at most

    address public immutable implementation;
    KeelGuardianV2.Protocol public protocol;

    address public admin;
    address public pendingAdmin;
    address public treasury;
    uint16 public protocolShareBps;

    mapping(address => address) public guardianOf;
    address[] private _all;

    event GuardianCreated(address indexed owner, address indexed guardian);
    event FeeConfigUpdated(address treasury, uint16 shareBps);
    event AdminTransferStarted(address indexed previousAdmin, address indexed newAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error AlreadyHasGuardian(address guardian);
    error NotAdmin();
    error FeeTooHigh();

    constructor(KeelGuardianV2.Protocol memory protocol_, address treasury_, uint16 shareBps_) {
        if (shareBps_ > MAX_PROTOCOL_SHARE_BPS) revert FeeTooHigh();
        implementation = address(new KeelGuardianV2());
        protocol = protocol_;
        admin = msg.sender;
        treasury = treasury_;
        protocolShareBps = shareBps_;
        emit AdminTransferred(address(0), msg.sender);
        emit FeeConfigUpdated(treasury_, shareBps_);
    }

    /// @notice Read by every guardian when it pays a keeper tip.
    function feeInfo() external view returns (address, uint16) {
        return (treasury, protocolShareBps);
    }

    function setFeeConfig(address treasury_, uint16 shareBps_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (shareBps_ > MAX_PROTOCOL_SHARE_BPS) revert FeeTooHigh();
        treasury = treasury_;
        protocolShareBps = shareBps_;
        emit FeeConfigUpdated(treasury_, shareBps_);
    }

    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice Create (or revert if existing) the caller's guardian account.
    function createGuardian() external returns (address guardian) {
        return _create(msg.sender);
    }

    /// @notice Create a guardian owned by `owner` (ownership is theirs; the caller gets no rights).
    function createGuardianFor(address owner) external returns (address guardian) {
        return _create(owner);
    }

    function predict(address owner) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(owner), address(this));
    }

    function totalGuardians() external view returns (uint256) {
        return _all.length;
    }

    function guardianAt(uint256 index) external view returns (address) {
        return _all[index];
    }

    /// @notice Paginated list for keeper bots that scan every guardian.
    function guardians(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _all.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = _all[i];
    }

    function _create(address owner) internal returns (address guardian) {
        address existing = guardianOf[owner];
        if (existing != address(0)) revert AlreadyHasGuardian(existing);
        guardian = Clones.cloneDeterministic(implementation, _salt(owner));
        KeelGuardianV2(payable(guardian)).initialize(owner, protocol);
        guardianOf[owner] = guardian;
        _all.push(guardian);
        emit GuardianCreated(owner, guardian);
    }

    function _salt(address owner) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(owner)));
    }
}
