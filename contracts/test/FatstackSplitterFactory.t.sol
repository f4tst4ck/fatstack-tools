// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FatstackSplitter} from "../src/FatstackSplitter.sol";
import {FatstackSplitterFactory} from "../src/FatstackSplitterFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract FatstackSplitterFactoryTest is Test {
    MockUSDC internal usdc;
    FatstackSplitterFactory internal factory;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant PROVIDER = address(0xA11CE);
    address internal constant OTHER_PROVIDER = address(0xB0B);
    address internal constant PAYER = address(0xBEEF);
    address internal constant ATTACKER = address(0xBAD);

    function setUp() public {
        usdc = new MockUSDC();
        factory = new FatstackSplitterFactory(address(usdc), TREASURY);
    }

    function test_deploysAtThePredictedAddress() public {
        // Predicted before it exists, so the registry can quote a splitter that has not
        // been deployed yet and anyone can check the quote without trusting us.
        address predicted = factory.splitterFor(PROVIDER);
        assertFalse(factory.isDeployed(PROVIDER));

        address deployed = address(factory.deploy(PROVIDER));

        assertEq(deployed, predicted, "address must be derivable in advance");
        assertTrue(factory.isDeployed(PROVIDER));
    }

    function test_eachProviderGetsADistinctSplitter() public {
        assertTrue(factory.splitterFor(PROVIDER) != factory.splitterFor(OTHER_PROVIDER));
    }

    function test_deployedSplitterPaysOnlyItsOwnProvider() public {
        FatstackSplitter splitter = factory.deploy(PROVIDER);
        assertEq(splitter.PROVIDER(), PROVIDER);
        assertEq(splitter.TREASURY(), TREASURY);
        assertEq(splitter.USDC(), address(usdc));
    }

    function test_cannotDeployTheSameProviderTwice() public {
        factory.deploy(PROVIDER);
        vm.expectRevert();
        factory.deploy(PROVIDER);
    }

    function test_deployIsPermissionlessAndGainsTheCallerNothing() public {
        // Anyone may deploy anyone's splitter, because the result can only ever pay that
        // provider. Restricting it would add an owner for no security benefit.
        vm.prank(ATTACKER);
        FatstackSplitter splitter = factory.deploy(PROVIDER);
        assertEq(splitter.PROVIDER(), PROVIDER, "the deployer is not the payee");
    }

    /**
     * @notice The attack that shaped this design.
     *
     * @dev An earlier draft took `provider` as an argument to `payWithAuthorization`. An
     *      EIP-3009 signature covers only `(from, to, value, validAfter, validBefore,
     *      nonce)` — not that argument — so anyone who observed a pending authorisation
     *      could submit it with their own address and take the provider's 98%.
     *
     *      Here the attacker holds a perfectly valid authorisation and submits it himself.
     *      He can do that; it changes nothing, because there is no argument to point
     *      anywhere else. The money reaches the provider and the attacker has paid the gas
     *      for the privilege.
     */
    function test_aStolenAuthorizationStillPaysTheProvider() public {
        FatstackSplitter splitter = factory.deploy(PROVIDER);
        usdc.mint(PAYER, 1_000_000);

        vm.prank(ATTACKER);
        splitter.payWithAuthorization(
            keccak256("uuid-batch"),
            PAYER,
            1_000_000,
            0,
            type(uint256).max,
            bytes32(uint256(1)),
            0,
            0,
            0
        );

        assertEq(usdc.balanceOf(PROVIDER), 980_000, "provider is paid regardless of submitter");
        assertEq(usdc.balanceOf(TREASURY), 20_000);
        assertEq(usdc.balanceOf(ATTACKER), 0, "the submitter receives nothing");
        assertEq(usdc.balanceOf(address(splitter)), 0);
    }

    function test_aMislabelledToolIdMovesNoMoney() public {
        // `toolId` is not covered by the signature either, so a submitter can label a
        // payment as any listing they like. That is why attribution is not taken from this
        // event alone — but no label can redirect a base unit.
        FatstackSplitter splitter = factory.deploy(PROVIDER);
        usdc.mint(PAYER, 1_000);

        vm.prank(ATTACKER);
        splitter.payWithAuthorization(
            keccak256("some-other-listing"),
            PAYER,
            1_000,
            0,
            type(uint256).max,
            bytes32(uint256(2)),
            0,
            0,
            0
        );

        assertEq(usdc.balanceOf(PROVIDER), 980);
        assertEq(usdc.balanceOf(TREASURY), 20);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(FatstackSplitterFactory.ZeroAddress.selector);
        new FatstackSplitterFactory(address(0), TREASURY);
        vm.expectRevert(FatstackSplitterFactory.ZeroAddress.selector);
        new FatstackSplitterFactory(address(usdc), address(0));
    }

    function testFuzz_predictionMatchesDeployment(address provider) public {
        vm.assume(provider != address(0));
        address predicted = factory.splitterFor(provider);
        assertEq(address(factory.deploy(provider)), predicted);
    }
}
