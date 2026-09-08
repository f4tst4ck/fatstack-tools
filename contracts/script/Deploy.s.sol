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
    /**
     * @notice Whether `FACTORY_ONLY` asks for a factory-only deploy.
     * @dev Accepts `1` or `true`. Anything else, including an unset variable, is false —
     *      a gate that turned itself on from a typo would be as bad as one that stayed off.
     */
    function parseFactoryOnly(string memory raw) public pure returns (bool) {
        bytes32 h = keccak256(bytes(raw));
        return h == keccak256("1") || h == keccak256("true");
    }

    /**
     * @notice Refuses to continue if a factory-only deploy would also deploy a splitter.
     *
     * @dev Step 1 of the go/no-go is the factory alone. Without this, "factory only" is the
     *      absence of a variable, and an absence is indistinguishable from a variable that
     *      failed to load — forge reads `.env` from the project root, and an
     *      `export PROVIDER_ADDRESS=...` earlier in the same shell survives. Either turns a
     *      one-transaction deploy into a two-transaction one with nothing on screen to say
     *      so. Asserting the intent makes the mistake loud instead of silent.
     */
    function requireFactoryOnly(bool factoryOnly, address provider) public pure {
        require(
            !factoryOnly || provider == address(0),
            "FACTORY_ONLY=1 but PROVIDER_ADDRESS is set: this would also deploy a splitter. Unset one of them."
        );
    }

    function run() external returns (FatstackSplitterFactory factory, address splitter) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address provider = vm.envOr("PROVIDER_ADDRESS", address(0));
        bool factoryOnly = parseFactoryOnly(vm.envOr("FACTORY_ONLY", string("")));

        require(usdc != address(0), "USDC_ADDRESS must be set");
        require(treasury != address(0), "TREASURY_ADDRESS must be set");
        require(usdc.code.length > 0, "USDC_ADDRESS has no code on this chain");
        requireFactoryOnly(factoryOnly, provider);

        // Logged before anything is broadcast, and in both directions. A run that deploys
        // only the factory must not look the same as a run whose PROVIDER_ADDRESS quietly
        // failed to load, so the mode is stated in the broadcast log either way.
        if (provider == address(0)) {
            console2.log("PROVIDER_ADDRESS: <unset> - factory only");
        } else {
            console2.log("PROVIDER_ADDRESS:", provider);
            console2.log("  a splitter WILL be deployed for this address in the same run");
        }
        console2.log("FACTORY_ONLY:", factoryOnly ? "1 (asserted)" : "<unset>");

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
