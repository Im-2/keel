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

/// @notice Where a guardian sends the protocol's share of each keeper tip (implemented by KeelGuardianFactoryV2).
interface IKeelFeeSource {
    function feeInfo() external view returns (address treasury, uint16 shareBps);
}

/// @title KeelGuardianV2
/// @notice A non-custodial "guardian account" that owns a single MUSD trove on behalf of its owner and can be kept
///         healthy by anyone (a permissionless keeper). V2 changes only the protection path:
///
///  - protect() never fails just because the reserve can't reach the target. It applies the best combination of
///    reserve BTC (top-up) and reserve MUSD (repayment) it can and reports a Full or Partial rescue.
///  - When MUSD forbids any useful adjustment (in Normal Mode, BorrowerOperations rejects every adjustment that
///    leaves ICR < MCR), it does nothing, returns Result.Insufficient and emits InsufficientReserve with exactly how
///    much BTC the reserve is missing, so the owner can be told what to add. No tip is paid and the cooldown is not
///    consumed when nothing happened.
///  - A share of the keeper tip (never more than MAX_PROTOCOL_SHARE_BPS of it) goes to Keel's treasury. The total the
///    owner pays is unchanged: still `tipBps` of the amount applied, capped at MAX_TIP_BPS (1%).
///
/// MUSD rules this follows (mezo-org/musd BorrowerOperations._adjustTrove):
///  - Normal Mode: an adjustment must leave ICR >= MCR (110%) and TCR >= CCR (150%).
///  - Recovery Mode: a collateral top-up and/or a debt repayment is allowed at any resulting ICR (no withdrawal, no
///    debt increase is involved here).
///  - A repayment must leave net debt >= minNetDebt and can't exceed debt - gas compensation.
///
/// Owner-only fund control, the 1% tip cap, the cooldown and reentrancy protection are the same as V1.
contract KeelGuardianV2 is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint256 public constant VERSION = 2;
    uint256 public constant MCR = 1.1e18; // MUSD liquidation threshold (110%)
    uint256 public constant MAX_TARGET_ICR = 5e18; // 500%
    uint256 public constant MAX_TIP_BPS = 100; // 1% of the amount applied, paid by the owner
    uint256 public constant MAX_PROTOCOL_SHARE_BPS = 5_000; // Keel takes at most half of that tip
    uint256 public constant BPS = 10_000;
    uint256 public constant MUSD_GAS_COMPENSATION = 200e18; // mirrors LiquityBase
    /// Smaller actions are treated as nothing to do (a keeper would spend more on gas than it moves).
    uint256 public constant MIN_BTC_ACTION = 1e12; // 0.000001 BTC
    uint256 public constant MIN_MUSD_ACTION = 1e16; // 0.01 MUSD

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
        uint16 tipBps; // total keeper tip, basis points of the amount applied (protocol share included)
        uint32 cooldown; // min seconds between two protect() calls that moved funds
        uint64 minICR; // 1e18-scaled trigger (e.g. 1.30e18 = 130%)
        uint64 targetICR; // 1e18-scaled target to restore to (e.g. 1.5e18)
    }

    enum Action {
        None,
        TopUpBTC,
        RepayMUSD,
        Both
    }

    enum Result {
        Full, // reached the target ratio
        Partial, // moved funds, but the reserve ran out before the target
        Insufficient // nothing the protocol would accept: no funds moved, no tip
    }

    /// One protection decision; also returned by previewProtect() so keepers and the bot see exactly what would happen.
    struct Plan {
        Result result;
        bool recoveryMode;
        uint256 icrBefore;
        uint256 btcToAdd;
        uint256 musdToRepay;
        uint256 icrAfter;
        uint256 btcShortfallToMCR; // extra reserve BTC needed to lift the loan to 110%
        uint256 btcShortfallToTarget; // extra reserve BTC needed to reach targetICR
    }

    // ---------------------------------------------------------------- storage

    address public owner;
    address public factory;
    Protocol public protocol;
    Config public config;
    uint64 public lastProtectedAt;
    address public pendingOwner;

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
    /// Same signature as V1, emitted for every rescue that moved funds (full or partial).
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
    /// The reserve lifted the loan only part of the way; `btcShortfall` more reserve BTC would have reached the target.
    event PartialRescue(
        address indexed keeper,
        uint256 btcAdded,
        uint256 musdRepaid,
        uint256 icrBefore,
        uint256 icrAfter,
        uint256 btcShortfall
    );
    /// Nothing could be applied. The owner needs `btcShortfallToMCR` more reserve BTC to make a rescue possible.
    event InsufficientReserve(
        address indexed keeper,
        uint256 icr,
        uint256 btcShortfallToMCR,
        uint256 btcShortfallToTarget,
        bool recoveryMode
    );
    event ProtocolFeePaid(address indexed treasury, uint256 btc, uint256 musd);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotPendingOwner();
    error NotEnabled();
    error NoTrove();
    error HealthyEnough(uint256 icr, uint256 minICR);
    error CooldownActive(uint256 availableAt);
    error InvalidConfig();
    error TransferFailed();
    error ZeroAddress();

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
        config = Config({enabled: true, tipBps: 20, cooldown: 300, minICR: 1.3e18, targetICR: 1.5e18});
        emit OwnershipTransferred(address(0), owner_);
    }

    receive() external payable {}

    // ---------------------------------------------------------------- owner: trove lifecycle (unchanged from V1)

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

    function withdrawCollateral(uint256 amount, address upperHint, address lowerHint, address to) external onlyOwner nonReentrant {
        if (to == address(0)) to = owner;
        protocol.borrowerOperations.withdrawColl(amount, upperHint, lowerHint);
        _sendBTC(to, amount);
        emit CollateralWithdrawn(amount, to);
    }

    function borrowMore(uint256 amount, address upperHint, address lowerHint, address to) external onlyOwner nonReentrant {
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

    /// @notice Close the trove. The guardian needs (debt - gas compensation) MUSD: it is pulled from the owner for
    ///         the shortfall versus the guardian's MUSD reserve. Collateral and the reserve return to the owner.
    function closeTrove() external onlyOwner nonReentrant {
        (, uint256 principal, uint256 interest, , uint256 pp, uint256 pi) = protocol.troveManager.getEntireDebtAndColl(address(this));
        uint256 total = principal + interest + pp + pi;
        uint256 needed = total > MUSD_GAS_COMPENSATION ? total - MUSD_GAS_COMPENSATION : 0;
        uint256 have = protocol.musd.balanceOf(address(this));
        if (have < needed) protocol.musd.safeTransferFrom(msg.sender, address(this), needed - have);
        protocol.borrowerOperations.closeTrove();
        _sweepAllTo(owner);
        emit TroveClosed();
    }

    function refinance(address upperHint, address lowerHint) external onlyOwner nonReentrant {
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

    /// @notice Fund the BTC reserve used for protective top-ups. Anyone may fund; only the owner can withdraw.
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

    /// @notice Rescue any other ERC20 accidentally sent here.
    function sweepToken(IERC20 token, address to) external onlyOwner {
        token.safeTransfer(to == address(0) ? owner : to, token.balanceOf(address(this)));
    }

    function configure(bool enabled, uint16 tipBps, uint32 cooldown, uint64 minICR, uint64 targetICR) external onlyOwner {
        if (tipBps > MAX_TIP_BPS || minICR <= MCR || targetICR <= minICR || targetICR > MAX_TARGET_ICR) revert InvalidConfig();
        config = Config(enabled, tipBps, cooldown, minICR, targetICR);
        emit ConfigUpdated(enabled, tipBps, cooldown, minICR, targetICR);
    }

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

    /// @notice What protect() would do right now. `eligible` is false when it would revert (disabled, no trove,
    ///         healthy enough, or in cooldown); otherwise `plan.result` says whether it would rescue fully, partly,
    ///         or not at all (and how much BTC the reserve is missing).
    function previewProtect() public view returns (bool eligible, Plan memory plan) {
        Config memory c = config;
        if (!c.enabled) return (false, plan);
        if (protocol.troveManager.getTroveStatus(address(this)) != ITroveManager.Status.active) return (false, plan);
        uint256 price = protocol.priceFeed.fetchPrice();
        plan = _plan(price, c);
        eligible = plan.icrBefore < c.minICR && block.timestamp >= uint256(lastProtectedAt) + c.cooldown;
    }

    /// @notice V1-compatible summary for keepers: protect only when it would move funds.
    function protectionStatus()
        external
        view
        returns (bool canProtect, uint256 icr, uint256 btcToAdd, uint256 musdToRepay, uint256 resultingICR)
    {
        (bool eligible, Plan memory p) = previewProtect();
        icr = p.icrBefore;
        if (!eligible || p.result == Result.Insufficient) return (false, icr, 0, 0, icr);
        return (true, icr, p.btcToAdd, p.musdToRepay, p.icrAfter);
    }

    /// @notice Restore the trove towards `targetICR` using the reserve, as far as the reserve and MUSD's rules allow.
    ///         Permissionless. Reverts only when the guardian is not eligible (disabled, no trove, healthy enough, in
    ///         cooldown); a reserve that is too small returns Result.Insufficient instead.
    /// @param upperHint,lowerHint optional SortedTroves hints; pass address(0) to have them computed on-chain.
    function protect(address upperHint, address lowerHint) external nonReentrant returns (Result) {
        Config memory c = config;
        if (!c.enabled) revert NotEnabled();
        ITroveManager tm = protocol.troveManager;
        if (tm.getTroveStatus(address(this)) != ITroveManager.Status.active) revert NoTrove();
        uint256 price = protocol.priceFeed.fetchPrice();
        Plan memory p = _plan(price, c);
        if (p.icrBefore >= c.minICR) revert HealthyEnough(p.icrBefore, c.minICR);
        uint256 availableAt = uint256(lastProtectedAt) + c.cooldown;
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);

        if (p.result == Result.Insufficient) {
            emit InsufficientReserve(msg.sender, p.icrBefore, p.btcShortfallToMCR, p.btcShortfallToTarget, p.recoveryMode);
            return Result.Insufficient;
        }

        lastProtectedAt = uint64(block.timestamp);
        (uint256 coll, uint256 debt) = _collAndDebt();
        (address u, address l) = (upperHint, lowerHint);
        if (u == address(0) && l == address(0)) (u, l) = _hints(coll + p.btcToAdd, debt - p.musdToRepay);
        // One adjustment, so MUSD checks the combined result (a top-up alone could still be under 110%).
        if (p.btcToAdd > 0 && p.musdToRepay > 0) {
            protocol.borrowerOperations.adjustTrove{value: p.btcToAdd}(0, p.musdToRepay, false, u, l);
        } else if (p.btcToAdd > 0) {
            protocol.borrowerOperations.addColl{value: p.btcToAdd}(u, l);
        } else {
            protocol.borrowerOperations.repayMUSD(p.musdToRepay, u, l);
        }
        uint256 icrAfter = tm.getCurrentICR(address(this), price);
        (uint256 tipBTC, uint256 tipMUSD) = _payTips(p.btcToAdd, p.musdToRepay, c.tipBps);

        Action action = p.btcToAdd > 0 && p.musdToRepay > 0 ? Action.Both : (p.btcToAdd > 0 ? Action.TopUpBTC : Action.RepayMUSD);
        emit Protected(msg.sender, action, p.btcToAdd, p.musdToRepay, p.icrBefore, icrAfter, tipBTC, tipMUSD);
        if (p.result == Result.Partial) {
            emit PartialRescue(msg.sender, p.btcToAdd, p.musdToRepay, p.icrBefore, icrAfter, p.btcShortfallToTarget);
        }
        return p.result;
    }

    // ---------------------------------------------------------------- views

    function position()
        external
        view
        returns (uint256 coll, uint256 debt, uint256 icr, uint256 price, uint256 reserveBTC, uint256 reserveMUSD)
    {
        price = protocol.priceFeed.fetchPrice();
        (coll, debt) = _collAndDebt();
        icr = debt == 0 ? type(uint256).max : _icr(coll, debt, price);
        reserveBTC = address(this).balance;
        reserveMUSD = protocol.musd.balanceOf(address(this));
    }

    // ---------------------------------------------------------------- internals

    /// Best use of the reserve: BTC first (it doesn't touch the owner's debt), then MUSD, each net of the tip.
    function _plan(uint256 price, Config memory c) internal view returns (Plan memory p) {
        (uint256 coll, uint256 debt) = _collAndDebt();
        p.icrBefore = _icr(coll, debt, price);
        p.recoveryMode = protocol.troveManager.checkRecoveryMode(price);
        uint256 reserveBTC = address(this).balance;
        uint256 gross = BPS + c.tipBps;

        uint256 requiredColl = _ceilDiv(debt * uint256(c.targetICR), price);
        if (requiredColl > coll) {
            uint256 need = requiredColl - coll;
            uint256 maxAdd = (reserveBTC * BPS) / gross; // the reserve must also cover the tip
            p.btcToAdd = need > maxAdd ? maxAdd : need;
            if (p.btcToAdd < MIN_BTC_ACTION && p.btcToAdd < need) p.btcToAdd = 0;
        }

        // Still short after the BTC? Repay debt from the MUSD reserve, keeping MUSD's minimum net debt.
        uint256 collAfter = coll + p.btcToAdd;
        uint256 allowedDebt = (collAfter * price) / uint256(c.targetICR);
        if (debt > allowedDebt) {
            uint256 want = debt - allowedDebt;
            uint256 maxRepay = (protocol.musd.balanceOf(address(this)) * BPS) / gross;
            uint256 floorDebt = MUSD_GAS_COMPENSATION + protocol.borrowerOperations.minNetDebt();
            uint256 cap = debt > floorDebt ? debt - floorDebt : 0;
            uint256 r = want < maxRepay ? want : maxRepay;
            p.musdToRepay = r < cap ? r : cap;
            if (p.musdToRepay < MIN_MUSD_ACTION) p.musdToRepay = 0;
        }

        uint256 debtAfter = debt - p.musdToRepay;
        p.icrAfter = _icr(collAfter, debtAfter, price);
        p.btcShortfallToTarget = _reserveShortfall(_ceilDiv(debtAfter * uint256(c.targetICR), price), coll, reserveBTC, gross);
        p.btcShortfallToMCR = _reserveShortfall(_ceilDiv(debtAfter * MCR, price), coll, reserveBTC, gross);

        if (p.btcToAdd == 0 && p.musdToRepay == 0) {
            p.result = Result.Insufficient;
        } else if (!p.recoveryMode && p.icrAfter < MCR) {
            // BorrowerOperations would reject it ("ICR < MCR is not permitted"): move nothing
            p.result = Result.Insufficient;
            p.btcToAdd = 0;
            p.musdToRepay = 0;
            p.icrAfter = p.icrBefore;
        } else {
            p.result = p.btcShortfallToTarget == 0 ? Result.Full : Result.Partial;
        }
    }

    /// Extra reserve BTC needed so that adding `requiredColl - coll` (plus its tip) is affordable.
    function _reserveShortfall(uint256 requiredColl, uint256 coll, uint256 reserveBTC, uint256 gross) internal pure returns (uint256) {
        if (requiredColl <= coll) return 0;
        uint256 needed = _ceilDiv((requiredColl - coll) * gross, BPS);
        return needed > reserveBTC ? needed - reserveBTC : 0;
    }

    /// Pay the keeper its tip, minus the protocol share that goes to Keel's treasury (both capped by the reserve).
    function _payTips(uint256 btcAdded, uint256 musdRepaid, uint16 tipBps) internal returns (uint256 tipBTC, uint256 tipMUSD) {
        (address treasury, uint256 shareBps) = _feeInfo();
        uint256 totalBTC = (btcAdded * tipBps) / BPS;
        uint256 totalMUSD = (musdRepaid * tipBps) / BPS;
        uint256 bal = address(this).balance;
        if (totalBTC > bal) totalBTC = bal;
        uint256 mbal = protocol.musd.balanceOf(address(this));
        if (totalMUSD > mbal) totalMUSD = mbal;

        uint256 feeBTC = (totalBTC * shareBps) / BPS;
        uint256 feeMUSD = (totalMUSD * shareBps) / BPS;
        tipBTC = totalBTC - feeBTC;
        tipMUSD = totalMUSD - feeMUSD;
        if (tipBTC > 0) _sendBTC(msg.sender, tipBTC);
        if (tipMUSD > 0) protocol.musd.safeTransfer(msg.sender, tipMUSD);
        if (feeBTC > 0 || feeMUSD > 0) {
            if (feeBTC > 0) _sendBTC(treasury, feeBTC);
            if (feeMUSD > 0) protocol.musd.safeTransfer(treasury, feeMUSD);
            emit ProtocolFeePaid(treasury, feeBTC, feeMUSD);
        }
    }

    /// The factory's fee setting, clamped to the hard cap here too; any failure means no fee.
    function _feeInfo() internal view returns (address treasury, uint256 shareBps) {
        try IKeelFeeSource(factory).feeInfo() returns (address t, uint16 s) {
            if (t == address(0)) return (address(0), 0);
            return (t, s > MAX_PROTOCOL_SHARE_BPS ? MAX_PROTOCOL_SHARE_BPS : s);
        } catch {
            return (address(0), 0);
        }
    }

    function _collAndDebt() internal view returns (uint256 coll, uint256 debt) {
        (uint256 c, uint256 p, uint256 i, uint256 pc, uint256 pp, uint256 pi) = protocol.troveManager.getEntireDebtAndColl(address(this));
        coll = c + pc;
        debt = p + i + pp + pi;
    }

    function _icr(uint256 coll, uint256 debt, uint256 price) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        return (coll * price) / debt;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
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
