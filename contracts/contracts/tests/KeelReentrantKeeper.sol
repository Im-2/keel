// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

interface IProtectable {
    function protect(address upperHint, address lowerHint) external returns (uint8);
}

/// Test-only keeper that tries to re-enter protect() when it receives its BTC tip.
contract KeelReentrantKeeper {
    IProtectable public target;
    bool public attacking;

    function run(IProtectable g) external {
        target = g;
        attacking = true;
        g.protect(address(0), address(0));
    }

    receive() external payable {
        if (attacking) {
            attacking = false;
            target.protect(address(0), address(0));
        }
    }
}
