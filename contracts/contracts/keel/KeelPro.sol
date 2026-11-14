// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title KeelPro
/// @notice Keel Pro subscriptions paid in MUSD, straight to Keel's treasury. Anyone can pay for any wallet (a gift or
///         a team plan); time stacks on top of an active subscription. The admin can change the price only within a
///         hard cap and can never take funds from subscribers: payment is a plain transfer at the moment of paying.
contract KeelPro {
    using SafeERC20 for IERC20;

    uint256 public constant PERIOD = 30 days;
    uint256 public constant MAX_PRICE = 100e18; // 100 MUSD per 30 days, at most
    uint256 public constant MAX_PERIODS = 24;

    IERC20 public immutable musd;
    address public admin;
    address public treasury;
    uint256 public pricePerPeriod;
    mapping(address => uint64) public paidUntil;

    event Subscribed(address indexed payer, address indexed account, uint256 periods, uint256 paid, uint64 until);
    event PriceUpdated(uint256 pricePerPeriod);
    event TreasuryUpdated(address treasury);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error NotAdmin();
    error PriceTooHigh();
    error BadPeriods();
    error ZeroAddress();

    constructor(IERC20 musd_, address treasury_, uint256 price_) {
        if (address(musd_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (price_ > MAX_PRICE) revert PriceTooHigh();
        musd = musd_;
        admin = msg.sender;
        treasury = treasury_;
        pricePerPeriod = price_;
        emit AdminTransferred(address(0), msg.sender);
    }

    /// @notice Pay for `periods` x 30 days of Pro for `account` (approve MUSD for this contract first).
    function subscribe(address account, uint256 periods) external returns (uint64 until) {
        if (account == address(0)) revert ZeroAddress();
        if (periods == 0 || periods > MAX_PERIODS) revert BadPeriods();
        uint256 amount = pricePerPeriod * periods;
        if (amount > 0) musd.safeTransferFrom(msg.sender, treasury, amount);
        uint64 start = paidUntil[account] > block.timestamp ? paidUntil[account] : uint64(block.timestamp);
        until = start + uint64(PERIOD * periods);
        paidUntil[account] = until;
        emit Subscribed(msg.sender, account, periods, amount, until);
    }

    function isPro(address account) external view returns (bool) {
        return paidUntil[account] > block.timestamp;
    }

    function setPrice(uint256 price_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (price_ > MAX_PRICE) revert PriceTooHigh();
        pricePerPeriod = price_;
        emit PriceUpdated(price_);
    }

    function setTreasury(address treasury_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
