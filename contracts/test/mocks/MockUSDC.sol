// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice A minimal EIP-3009 token standing in for USDC.
 *
 * @dev Signature verification is deliberately not reimplemented: these tests are about the
 *      splitter's arithmetic and its handling of a token that misbehaves, not about
 *      recovering an ECDSA signature — the fork test exercises the real USDC for that.
 *      What is faithful is the part that matters: `receiveWithAuthorization` requires
 *      `msg.sender == to`, and each nonce may be used once.
 */
contract MockUSDC {
    string public constant name = "USD Coin";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    /// @dev Knobs for the hostile cases.
    bool public transferReturnsFalse;
    bool public transferReverts;
    uint256 public transferTaxBps;

    error AuthorizationUsed();
    error CallerMustBeRecipient();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setTransferReturnsFalse(bool value) external {
        transferReturnsFalse = value;
    }

    function setTransferReverts(bool value) external {
        transferReverts = value;
    }

    function setTransferTaxBps(uint256 bps) external {
        transferTaxBps = bps;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferReverts) revert("token reverted");
        if (transferReturnsFalse) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
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
        if (msg.sender != to) revert CallerMustBeRecipient();
        if (authorizationState[from][nonce]) revert AuthorizationUsed();
        authorizationState[from][nonce] = true;

        uint256 delivered = value - (value * transferTaxBps) / 10_000;
        balanceOf[from] -= value;
        balanceOf[to] += delivered;
    }
}
