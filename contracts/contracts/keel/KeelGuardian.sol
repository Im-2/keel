// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IBorrowerOperations.sol";
import "../interfaces/ITroveManager.sol";
import "../interfaces/IPriceFeed.sol";
import "../interfaces/IHintHelpers.sol";
import "../interfaces/ISortedTroves.sol";

/// @title KeelGuardian
/// @notice A non-custodial "guardian account" that owns a single MUSD trove on behalf of its owner
///         and can be kept healthy by anyone (a permissionless keeper) without ever being able to
///         move the owner's funds anywhere except into the trove (or a small, capped keeper tip).
///
/// Threat model summary:
///  - Only `owner` can open/close/borrow/withdraw/sweep/configure.
///  - Anyone can call `protect()`, but only when the trove ICR is below the owner's `minICR`
///    trigger, and the call can only (a) add reserve BTC as collateral, (b) repay debt with reserve
///    MUSD, and (c) pay the keeper a tip bounded by `tipBps` (<= MAX_TIP_BPS) of the amount used.
///  - A cooldown stops repeated tip-farming.
///
/// Built on top of Mezo's MUSD (Liquity/Threshold fork, GPL-3.0). See https://github.com/mezo-org/musd
contract KeelGuardian is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint256 public constant MCR = 1.1e18; // MUSD liquidation threshold (110%)
    uint256 public constant MAX_TARGET_ICR = 5e18; // 500%
    uint256 public constant MAX_TIP_BPS = 100; // 1%
    uint256 public constant BPS = 10_000;
    uint256 public constant MUSD_GAS_COMPENSATION = 200e18; // mirrors LiquityBase

    // ---------------------------------------------------------------- types

    struct Protocol {
        IBorrowerOperations borrowerOperations;
        ITroveManager troveManager;
        IPriceFeed priceFeed;
        IHintHelpers hintHelpers;
        ISortedTroves sortedTroves;
        IERC20 musd;
    }

    struct Config {
        bool enabled;
        uint16 tipBps; // keeper tip, basis points of the amount applied
        uint32 cooldown; // min seconds between two protect() calls
        uint64 minICR; // 1e18-scaled trigger (e.g. 1.30e18 = 130%) - stored as uint64, max ~18.4e18
        uint64 targetICR; // 1e18-scaled target to restore to (e.g. 1.5e18)
    }

    enum Action {
        None,
        TopUpBTC,
        RepayMUSD,
        Both
    }

    // ---------------------------------------------------------------- storage

    address public owner;
    address public factory;
    Protocol public protocol;
    Config public config;
    uint64 public lastProtectedAt;

    // ---------------------------------------------------------------- events

    event TroveOpened(uint256 collateral, uint256 debt, address recipient);
    event CollateralAdded(uint256 amount);
    event CollateralWithdrawn(uint256 amount, address to);
    event Borrowed(uint256 amount, address to);
    event Repaid(uint256 amount);
    event TroveClosed();
    event Refinanced();
    event SurplusClaimed(address to);
    event ReserveFunded(address indexed from, uint256 btcAmount);
    event ConfigUpdated(bool enabled, uint16 tipBps, uint32 cooldown, uint64 minICR, uint64 targetICR);
    event Protected(
        address indexed keeper,
        Action action,
        uint256 btcAdded,
        uint256 musdRepaid,
        uint256 icrBefore,
        uint256 icrAfter,
        uint256 tipBTC,
        uint256 tipMUSD
    );
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotPendingOwner();
    error NotEnabled();
    error NoTrove();
    error HealthyEnough(uint256 icr, uint256 minICR);
    error CooldownActive(uint256 availableAt);
    error NothingToDo();
    error InvalidConfig();
    error TransferFailed();
    error ZeroAddress();

    // ---------------------------------------------------------------- init

    address public pendingOwner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, Protocol calldata protocol_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __ReentrancyGuard_init();
        owner = owner_;
        factory = msg.sender;
        protocol = protocol_;
        // Safe defaults: protection on, trigger 130%, restore to 150%, 0.2% tip, 5 min cooldown.
        config = Config({
            enabled: true,
            tipBps: 20,
            cooldown: 300,
            minICR: 1.3e18,
            targetICR: 1.5e18
        });
        emit OwnershipTransferred(address(0), owner_);
    }

    receive() external payable {}

    // ---------------------------------------------------------------- owner: trove lifecycle

    /// @notice Open the trove. `msg.value` is the collateral; minted MUSD is forwarded to `recipient`.
    function openTrove(
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        address recipient
    ) external payable onlyOwner nonReentrant {
        if (recipient == address(0)) recipient = owner;
        IERC20 musd = protocol.musd;
        uint256 before = musd.balanceOf(address(this));
        protocol.borrowerOperations.openTrove{value: msg.value}(debtAmount, upperHint, lowerHint);
        uint256 minted = musd.balanceOf(address(this)) - before;
        if (minted > 0) musd.safeTransfer(recipient, minted);
        emit TroveOpened(msg.value, debtAmount, recipient);
    }

    function addCollateral(address upperHint, address lowerHint) external payable onlyOwner nonReentrant {
        protocol.borrowerOperations.addColl{value: msg.value}(upperHint, lowerHint);
        emit CollateralAdded(msg.value);
    }

    function withdrawCollateral(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address to
    ) external onlyOwner nonReentrant {
        if (to == address(0)) to = owner;
        protocol.borrowerOperations.withdrawColl(amount, upperHint, lowerHint);
        _sendBTC(to, amount);
        emit CollateralWithdrawn(amount, to);
    }

    function borrowMore(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address to
    ) external onlyOwner nonReentrant {
        if (to == address(0)) to = owner;
        protocol.borrowerOperations.withdrawMUSD(amount, upperHint, lowerHint);
        protocol.musd.safeTransfer(to, amount);
        emit Borrowed(amount, to);
    }

    /// @notice Repay debt, pulling MUSD from the owner (owner must have approved this contract).
    function repay(uint256 amount, address upperHint, address lowerHint) external onlyOwner nonReentrant {
        protocol.musd.safeTransferFrom(msg.sender, address(this), amount);
        protocol.borrowerOperations.repayMUSD(amount, upperHint, lowerHint);
        emit Repaid(amount);
    }

    /// @notice Close the trove. The guardian needs (debt - gas compensation) MUSD: it is pulled from the
    ///         owner for the shortfall versus the guardian's MUSD reserve. Collateral returns to the owner.
    function closeTrove() external onlyOwner nonReentrant {
        (, uint256 principal, uint256 interest, , uint256 pp, uint256 pi) = protocol
            .troveManager
            .getEntireDebtAndColl(address(this));
        uint256 total = principal + interest + pp + pi;
        uint256 needed = total > MUSD_GAS_COMPENSATION ? total - MUSD_GAS_COMPENSATION : 0;
        uint256 have = protocol.musd.balanceOf(address(this));
        if (have < needed) {
            protocol.musd.safeTransferFrom(msg.sender, address(this), needed - have);
        }
        protocol.borrowerOperations.closeTrove();
        // All BTC (returned collateral + reserve) and leftover MUSD go to the owner.
        _sweepAllTo(owner);
        emit TroveClosed();
    }

    function refinance(address upperHint, address lowerHint) external onlyOwner nonReentrant {
        // Refinancing fee is added to debt by the protocol; no funds needed.
        protocol.borrowerOperations.refinance(upperHint, lowerHint);
        emit Refinanced();
    }

    function claimSurplus(address to) external onlyOwner nonReentrant {
        if (to == address(0)) to = owner;
        protocol.borrowerOperations.claimCollateral();
        _sendBTC(to, address(this).balance);
        emit SurplusClaimed(to);
    }

    // ---------------------------------------------------------------- owner: reserve + config

    /// @notice Fund the BTC reserve used for protective top-ups. Anyone may fund; only owner can withdraw.
    function fundReserve() external payable {
        emit ReserveFunded(msg.sender, msg.value);
    }

    function withdrawReserveBTC(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) to = owner;
        _sendBTC(to, amount);
    }

    function withdrawReserveMUSD(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) to = owner;
        protocol.musd.safeTransfer(to, amount);
    }

    /// @notice Rescue any other ERC20 accidentally sent here (MUSD reserve withdrawals use the function above).
    function sweepToken(IERC20 token, address to) external onlyOwner {
        token.safeTransfer(to == address(0) ? owner : to, token.balanceOf(address(this)));
    }

    function configure(
        bool enabled,
        uint16 tipBps,
        uint32 cooldown,
        uint64 minICR,
        uint64 targetICR
    ) external onlyOwner {
        if (
            tipBps > MAX_TIP_BPS ||
            minICR <= MCR ||
            targetICR <= minICR ||
            targetICR > MAX_TARGET_ICR
        ) revert InvalidConfig();
        config = Config(enabled, tipBps, cooldown, minICR, targetICR);
        emit ConfigUpdated(enabled, tipBps, cooldown, minICR, targetICR);
    }

    // two-step ownership transfer
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- keeper: protection

    /// @notice Everything a keeper needs to decide whether to call `protect()`.
    function protectionStatus()
        public
        view
        returns (
            bool canProtect,
            uint256 icr,
            uint256 btcToAdd,
            uint256 musdToRepay,
            uint256 resultingICR
        )
    {
        Config memory c = config;
        if (!c.enabled) return (false, 0, 0, 0, 0);
        ITroveManager tm = protocol.troveManager;
        if (tm.getTroveStatus(address(this)) != ITroveManager.Status.active) return (false, 0, 0, 0, 0);

        uint256 price = protocol.priceFeed.fetchPrice();
        icr = tm.getCurrentICR(address(this), price);
        if (icr >= c.minICR) return (false, icr, 0, 0, icr);
        if (block.timestamp < uint256(lastProtectedAt) + c.cooldown) return (false, icr, 0, 0, icr);

        (uint256 coll, uint256 debt) = _collAndDebt();
        (btcToAdd, musdToRepay) = _plan(coll, debt, price, c);
        resultingICR = _icr(coll + btcToAdd, debt - musdToRepay, price);
        canProtect = btcToAdd > 0 || musdToRepay > 0;
    }

    /// @notice Restore the trove towards `targetICR` using the reserve. Permissionless.
    /// @param upperHint,lowerHint optional SortedTroves hints; pass address(0) to have them computed on-chain.
    function protect(address upperHint, address lowerHint) external nonReentrant returns (Action action) {
        Config memory c = config;
        if (!c.enabled) revert NotEnabled();
        if (protocol.troveManager.getTroveStatus(address(this)) != ITroveManager.Status.active) revert NoTrove();

        Applied memory a;
        uint256 price = protocol.priceFeed.fetchPrice();
        a.icrBefore = protocol.troveManager.getCurrentICR(address(this), price);
        if (a.icrBefore >= c.minICR) revert HealthyEnough(a.icrBefore, c.minICR);
        uint256 availableAt = uint256(lastProtectedAt) + c.cooldown;
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);

        (uint256 coll, uint256 debt) = _collAndDebt();
        (a.btcAdded, a.musdRepaid) = _plan(coll, debt, price, c);
        if (a.btcAdded == 0 && a.musdRepaid == 0) revert NothingToDo();

        lastProtectedAt = uint64(block.timestamp);

        _applyTopUp(a, coll, debt, upperHint, lowerHint, c.tipBps);
        _applyRepay(a, coll + a.btcAdded, debt, upperHint, lowerHint, c.tipBps);
        _payKeeper(a);

        action = a.btcAdded > 0 && a.musdRepaid > 0
            ? Action.Both
            : (a.btcAdded > 0 ? Action.TopUpBTC : Action.RepayMUSD);
        emit Protected(
            msg.sender,
            action,
            a.btcAdded,
            a.musdRepaid,
            a.icrBefore,
            protocol.troveManager.getCurrentICR(address(this), price),
            a.tipBTC,
            a.tipMUSD
        );
    }

    struct Applied {
        uint256 btcAdded;
        uint256 musdRepaid;
        uint256 icrBefore;
        uint256 tipBTC;
        uint256 tipMUSD;
    }

    function _applyTopUp(
        Applied memory a,
        uint256 coll,
        uint256 debt,
        address upperHint,
        address lowerHint,
        uint16 tipBps
    ) internal {
        if (a.btcAdded == 0) return;
        (address u, address l) = _pickHints(upperHint, lowerHint, coll + a.btcAdded, debt);
        protocol.borrowerOperations.addColl{value: a.btcAdded}(u, l);
        a.tipBTC = (a.btcAdded * tipBps) / BPS;
    }

    function _applyRepay(
        Applied memory a,
        uint256 coll,
        uint256 debt,
        address upperHint,
        address lowerHint,
        uint16 tipBps
    ) internal {
        if (a.musdRepaid == 0) return;
        (address u, address l) = _pickHints(upperHint, lowerHint, coll, debt - a.musdRepaid);
        protocol.borrowerOperations.repayMUSD(a.musdRepaid, u, l);
        a.tipMUSD = (a.musdRepaid * tipBps) / BPS;
    }

    function _payKeeper(Applied memory a) internal {
        if (a.tipBTC > 0) {
            uint256 bal = address(this).balance;
            if (a.tipBTC > bal) a.tipBTC = bal;
            if (a.tipBTC > 0) _sendBTC(msg.sender, a.tipBTC);
        }
        if (a.tipMUSD > 0) {
            uint256 mbal = protocol.musd.balanceOf(address(this));
            if (a.tipMUSD > mbal) a.tipMUSD = mbal;
            if (a.tipMUSD > 0) protocol.musd.safeTransfer(msg.sender, a.tipMUSD);
        }
    }

    function _pickHints(
        address upperHint,
        address lowerHint,
        uint256 newColl,
        uint256 newDebt
    ) internal view returns (address, address) {
        if (upperHint == address(0) && lowerHint == address(0)) return _hints(newColl, newDebt);
        return (upperHint, lowerHint);
    }

    // ---------------------------------------------------------------- views

    function position()
        external
        view
        returns (
            uint256 coll,
            uint256 debt,
            uint256 icr,
            uint256 price,
            uint256 reserveBTC,
            uint256 reserveMUSD
        )
    {
        price = protocol.priceFeed.fetchPrice();
        (coll, debt) = _collAndDebt();
        icr = debt == 0 ? type(uint256).max : _icr(coll, debt, price);
        reserveBTC = address(this).balance;
        reserveMUSD = protocol.musd.balanceOf(address(this));
    }

    // ---------------------------------------------------------------- internals

    function _collAndDebt() internal view returns (uint256 coll, uint256 debt) {
        (uint256 c, uint256 p, uint256 i, uint256 pc, uint256 pp, uint256 pi) =
            protocol.troveManager.getEntireDebtAndColl(address(this));
        coll = c + pc;
        debt = p + i + pp + pi;
    }

    function _icr(uint256 coll, uint256 debt, uint256 price) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        return (coll * price) / debt;
    }

    /// Decide how much reserve BTC to add and/or MUSD to repay to reach `targetICR`, net of tips.
    function _plan(
        uint256 coll,
        uint256 debt,
        uint256 price,
        Config memory c
    ) internal view returns (uint256 btcToAdd, uint256 musdToRepay) {
        uint256 requiredColl = (debt * uint256(c.targetICR)) / price;
        if (requiredColl > coll) {
            uint256 need = requiredColl - coll;
            // Reserve must cover the top-up plus its tip.
            uint256 maxAdd = (address(this).balance * BPS) / (BPS + c.tipBps);
            btcToAdd = need > maxAdd ? maxAdd : need;
        } else {
            return (0, 0);
        }

        // Still short after using BTC? Use MUSD reserve to repay debt.
        uint256 collAfter = coll + btcToAdd;
        uint256 allowedDebt = (collAfter * price) / uint256(c.targetICR);
        if (debt > allowedDebt) {
            uint256 want = debt - allowedDebt;
            uint256 musdBal = protocol.musd.balanceOf(address(this));
            uint256 maxRepay = (musdBal * BPS) / (BPS + c.tipBps);
            musdToRepay = want > maxRepay ? maxRepay : want;

            // Respect the protocol's minimum net debt (net debt = debt - gas compensation).
            uint256 minNet = protocol.borrowerOperations.minNetDebt();
            uint256 floorDebt = MUSD_GAS_COMPENSATION + minNet;
            uint256 cap = debt > floorDebt ? debt - floorDebt : 0;
            if (musdToRepay > cap) musdToRepay = cap;
        }
    }

    function _hints(uint256 newColl, uint256 newDebt) internal view returns (address upper, address lower) {
        if (newDebt == 0) return (address(0), address(0));
        uint256 nicr = protocol.hintHelpers.computeNominalCR(newColl, newDebt);
        (address approx, , ) = protocol.hintHelpers.getApproxHint(nicr, 15, block.timestamp);
        (upper, lower) = protocol.sortedTroves.findInsertPosition(nicr, approx, approx);
    }

    function _sendBTC(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _sweepAllTo(address to) internal {
        uint256 bal = address(this).balance;
        if (bal > 0) _sendBTC(to, bal);
        uint256 m = protocol.musd.balanceOf(address(this));
        if (m > 0) protocol.musd.safeTransfer(to, m);
    }
}
