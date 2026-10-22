// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./KeelGuardian.sol";

/// @title KeelGuardianFactory
/// @notice Deploys one deterministic KeelGuardian clone per user. Immutable after construction:
///         no admin, no upgrade path, no fees.
contract KeelGuardianFactory {
    address public immutable implementation;
    KeelGuardian.Protocol public protocol;

    mapping(address => address) public guardianOf;
    address[] private _all;

    event GuardianCreated(address indexed owner, address indexed guardian);

    error AlreadyHasGuardian(address guardian);

    constructor(KeelGuardian.Protocol memory protocol_) {
        implementation = address(new KeelGuardian());
        protocol = protocol_;
    }

    /// @notice Create (or revert if existing) the caller's guardian account.
    function createGuardian() external returns (address guardian) {
        return _create(msg.sender);
    }

    /// @notice Create a guardian owned by `owner` (e.g. a bot onboarding flow can pre-create it; ownership is theirs).
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
        KeelGuardian(payable(guardian)).initialize(owner, protocol);
        guardianOf[owner] = guardian;
        _all.push(guardian);
        emit GuardianCreated(owner, guardian);
    }

    function _salt(address owner) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(owner)));
    }
}
