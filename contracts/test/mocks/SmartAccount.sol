// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * A stand-in for an ERC-4337 smart account of the kind a passkey wallet deploys.
 *
 * It has code, it has no `receive`, it has no ERC-20 callback, and it reverts on a bare ETH
 * transfer — which is the point. A payout must not depend on the recipient cooperating,
 * because a provider's wallet is a contract we did not write and cannot change.
 */
contract SmartAccount {
    /// @dev Deliberately absent: `receive()` and `fallback()`. A plain ETH send here fails.
    function owner() external pure returns (address) {
        return address(0xBEEFCAFE);
    }
}

/**
 * A recipient that actively rejects anything with a callback, to prove none is used.
 *
 * ERC-20 `transfer` never calls the recipient — unlike ERC-721's `safeTransferFrom` or
 * ERC-777's hooks. If the splitter ever gained a notification step, this contract would make
 * the payout revert rather than let it pass unnoticed.
 */
contract HostileRecipient {
    fallback() external payable {
        revert("no callbacks accepted");
    }
}
