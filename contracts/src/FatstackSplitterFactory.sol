// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FatstackSplitter} from "./FatstackSplitter.sol";

/**
 * @title FatstackSplitterFactory
 * @notice Deploys one splitter per provider, at an address anyone can compute in advance.
 *
 * @dev The provider must be fixed at construction — see the note in `FatstackSplitter` on
 *      why taking it as a call parameter lets a bystander steal the payment — which means
 *      one contract per provider. This makes that cheap and, more importantly, verifiable:
 *      the address is derived with CREATE2 from the provider alone, so anyone can check
 *      that the splitter a 402 quotes is the one that pays that provider, without trusting
 *      us or a lookup table we control.
 *
 *      The factory holds no funds, has no owner, and its only state is the token and
 *      treasury it was constructed with. `deploy` is permissionless: there is nothing to
 *      gain by deploying someone else's splitter, since the result can only pay them.
 */
contract FatstackSplitterFactory {
    address public immutable USDC;
    address public immutable TREASURY;

    event SplitterDeployed(address indexed provider, address splitter);

    error ZeroAddress();

    constructor(address usdc, address treasury) {
        if (usdc == address(0) || treasury == address(0)) revert ZeroAddress();
        USDC = usdc;
        TREASURY = treasury;
    }

    /// @notice Deploys the splitter for `provider`, or reverts if it already exists.
    function deploy(address provider) external returns (FatstackSplitter splitter) {
        splitter = new FatstackSplitter{salt: _salt(provider)}(USDC, provider, TREASURY);
        emit SplitterDeployed(provider, address(splitter));
    }

    /**
     * @notice Where `provider`'s splitter lives, deployed or not.
     * @dev Lets the registry quote an address before the contract exists, and lets anyone
     *      verify that a quoted splitter really belongs to the provider it claims.
     */
    function splitterFor(address provider) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(FatstackSplitter).creationCode, abi.encode(USDC, provider, TREASURY)
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), _salt(provider), initCodeHash)
                    )
                )
            )
        );
    }

    /// @notice Whether that address has been deployed yet.
    function isDeployed(address provider) external view returns (bool) {
        return splitterFor(provider).code.length > 0;
    }

    function _salt(address provider) private pure returns (bytes32) {
        return bytes32(uint256(uint160(provider)));
    }
}
