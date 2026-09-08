// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FatstackSplitterFactory} from "../src/FatstackSplitterFactory.sol";
import {FatstackSplitter} from "../src/FatstackSplitter.sol";

/**
 * @notice Deploys the factory, and optionally one provider's splitter.
 *
 * @dev Every address comes from the environment and none has a default. The contracts are
 *      immutable, so a wrong treasury cannot be corrected afterwards — a typo here is
 *      permanent, and a default would make a typo silent.
 *
 *      The deployer key is read from the environment and never committed. On mainnet it
 *      should come from a hardware wallet or a one-shot key.
 *
 *   Base Sepolia:
 *     USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
 *     TREASURY_ADDRESS=0x... \
 *     forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --verify
 *
 *   Base mainnet uses USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 and is deployed by
 *   hand after reading the source. See POST_DEPLOY.md.
 */
contract Deploy is Script {
    function run() external returns (FatstackSplitterFactory factory, address splitter) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address provider = vm.envOr("PROVIDER_ADDRESS", address(0));

        require(usdc != address(0), "USDC_ADDRESS must be set");
        require(treasury != address(0), "TREASURY_ADDRESS must be set");
        require(usdc.code.length > 0, "USDC_ADDRESS has no code on this chain");

        // Read from the environment, never passed on the command line: an argument ends
        // up in shell history and in the process list. On mainnet, omit it entirely and
        // let forge use a hardware wallet — see POST_DEPLOY.md.
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }
        factory = new FatstackSplitterFactory(usdc, treasury);
        if (provider != address(0)) {
            splitter = address(factory.deploy(provider));
        }
        vm.stopBroadcast();

        console2.log("FatstackSplitterFactory:", address(factory));
        console2.log("  USDC:     ", factory.USDC());
        console2.log("  TREASURY: ", factory.TREASURY());
        if (splitter != address(0)) {
            console2.log("Splitter for provider:", provider);
            console2.log("  at:", splitter);
            console2.log("  predicted:", factory.splitterFor(provider));
            console2.log("  provider on-chain:", FatstackSplitter(splitter).PROVIDER());
        }
        console2.log("Check every line above against what you intended before using it.");
    }
}
