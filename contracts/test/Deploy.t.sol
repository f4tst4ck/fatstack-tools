// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/**
 * @notice The gate that keeps step 1 of the go/no-go to one transaction.
 *
 * @dev Before this existed, "factory only" was the *absence* of `PROVIDER_ADDRESS`. An
 *      absence cannot be distinguished from a variable that failed to load, and forge reads
 *      `.env` from the project root, so a stale value turned a one-transaction deploy into
 *      a two-transaction one with nothing on screen to say so.
 */
contract DeployGateTest is Test {
    Deploy internal script;

    address internal constant PROVIDER = address(0xA11CE);

    function setUp() public {
        script = new Deploy();
    }

    // --- the gate ---------------------------------------------------------------------

    function test_factoryOnlyWithNoProviderIsAllowed() public view {
        script.requireFactoryOnly(true, address(0));
    }

    function test_factoryOnlyWithAProviderReverts() public {
        vm.expectRevert(
            bytes(
                "FACTORY_ONLY=1 but PROVIDER_ADDRESS is set: this would also deploy a splitter. Unset one of them."
            )
        );
        script.requireFactoryOnly(true, PROVIDER);
    }

    function test_withoutTheGateAProviderIsStillAllowed() public view {
        // Step 2 deploys a provider's splitter deliberately. The gate is an assertion of
        // intent, not a ban on the second transaction.
        script.requireFactoryOnly(false, PROVIDER);
    }

    function test_withoutTheGateNoProviderIsAllowed() public view {
        script.requireFactoryOnly(false, address(0));
    }

    function testFuzz_theGateOnlyEverBlocksTheOneCase(bool factoryOnly, address provider) public {
        if (factoryOnly && provider != address(0)) {
            vm.expectRevert();
            script.requireFactoryOnly(factoryOnly, provider);
        } else {
            script.requireFactoryOnly(factoryOnly, provider);
        }
    }

    // --- parsing ----------------------------------------------------------------------

    function test_recognisesOneAndTrue() public view {
        assertTrue(script.parseFactoryOnly("1"));
        assertTrue(script.parseFactoryOnly("true"));
    }

    function test_unsetIsOff() public view {
        assertFalse(script.parseFactoryOnly(""));
    }

    function test_anythingElseIsOff() public view {
        // A gate that switched itself on from a typo would be as bad as one that stayed
        // off: step 2 would start failing for a reason nobody had asked for.
        assertFalse(script.parseFactoryOnly("0"));
        assertFalse(script.parseFactoryOnly("false"));
        assertFalse(script.parseFactoryOnly("TRUE"));
        assertFalse(script.parseFactoryOnly("yes"));
        assertFalse(script.parseFactoryOnly(" 1"));
    }
}
