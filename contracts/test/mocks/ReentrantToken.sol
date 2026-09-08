// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FatstackSplitter} from "../../src/FatstackSplitter.sol";

/**
 * @notice A token that calls back into the splitter while paying the provider.
 *
 * @dev USDC does not do this. The point is to show the splitter holds up against a token
 *      that does — because "the token we configured would never behave that way" is an
 *      assumption, and an immutable contract has to survive the assumption being wrong.
 */
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    FatstackSplitter public splitter;
    bool public reentered;
    bool private attacking;

    function setSplitter(FatstackSplitter s) external {
        splitter = s;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (!attacking) {
            attacking = true;
            reentered = true;
            // Re-enter mid-payment with the same authorisation nonce.
            try splitter.payWithAuthorization(
                bytes32(0),
                address(0xBEEF),
                1_000,
                0,
                type(uint256).max,
                bytes32(uint256(7)),
                0,
                0,
                0
            ) {}
                catch {}
            attacking = false;
        }
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32 nonce,
        uint8,
        bytes32,
        bytes32
    ) external {
        require(msg.sender == to, "caller must be recipient");
        require(!authorizationState[from][nonce], "authorization used");
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}
