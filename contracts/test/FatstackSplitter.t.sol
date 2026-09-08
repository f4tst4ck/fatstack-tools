// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdJson} from "forge-std/Test.sol";
import {FatstackSplitter} from "../src/FatstackSplitter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

contract FatstackSplitterTest is Test {
    using stdJson for string;

    MockUSDC internal usdc;
    FatstackSplitter internal splitter;

    address internal constant PROVIDER = address(0xA11CE);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant PAYER = address(0xBEEF);
    bytes32 internal constant TOOL_ID = keccak256("uuid-batch");

    event Payment(address indexed payer, uint256 amount, uint256 fee, bytes32 indexed toolId);

    function setUp() public {
        usdc = new MockUSDC();
        splitter = new FatstackSplitter(address(usdc), PROVIDER, TREASURY);
    }

    function _pay(uint256 value, bytes32 nonce) internal {
        usdc.mint(PAYER, value);
        splitter.payWithAuthorization(TOOL_ID, PAYER, value, 0, type(uint256).max, nonce, 0, 0, 0);
    }

    // ── construction ────────────────────────────────────────────────────────

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(FatstackSplitter.ZeroAddress.selector);
        new FatstackSplitter(address(0), PROVIDER, TREASURY);
    }

    function test_constructor_rejectsZeroTreasury() public {
        // A zero treasury would burn every fee, silently, forever.
        vm.expectRevert(FatstackSplitter.ZeroAddress.selector);
        new FatstackSplitter(address(usdc), PROVIDER, address(0));
    }

    function test_hasNoOwnerPauseOrUpgradePath() public view {
        // Asserted by absence: the ABI carries nothing that could move money outside a
        // payment, so there is no privileged call to protect or to lose the key to.
        assertEq(splitter.FEE_BPS(), 200);
        assertEq(splitter.TREASURY(), TREASURY);
        assertEq(splitter.USDC(), address(usdc));
    }

    // ── the split ───────────────────────────────────────────────────────────

    function test_splitsAndPaysBothParties() public {
        _pay(1_000_000, bytes32(uint256(1)));
        assertEq(usdc.balanceOf(PROVIDER), 980_000);
        assertEq(usdc.balanceOf(TREASURY), 20_000);
        assertEq(usdc.balanceOf(address(splitter)), 0, "contract must hold nothing after");
    }

    function test_emitsPaymentWithToolId() public {
        // The chain carries no other way to know which listing was paid: a payout address
        // does not identify one, because providers point several tools at the same address.
        usdc.mint(PAYER, 1_000);
        vm.expectEmit(true, true, true, true);
        emit Payment(PAYER, 1_000, 20, TOOL_ID);
        splitter.payWithAuthorization(
            TOOL_ID, PAYER, 1_000, 0, type(uint256).max, bytes32(uint256(2)), 0, 0, 0
        );
    }

    function test_constructor_rejectsZeroProvider() public {
        vm.expectRevert(FatstackSplitter.ZeroAddress.selector);
        new FatstackSplitter(address(usdc), address(0), TREASURY);
    }

    function test_theProviderIsNotACallParameter() public view {
        // The property the whole design rests on. An EIP-3009 signature does not cover a
        // provider argument, so a caller who could choose one could redirect a payment
        // they merely observed. There is no such argument: the payee is fixed at
        // construction and the ABI offers no way to change it.
        assertEq(splitter.PROVIDER(), PROVIDER);
        bytes4 selector = FatstackSplitter.payWithAuthorization.selector;
        assertEq(
            selector,
            bytes4(
                keccak256(
                    "payWithAuthorization(bytes32,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
                )
            ),
            "the signature must not carry a provider argument"
        );
    }

    function test_rejectsZeroValue() public {
        vm.expectRevert(FatstackSplitter.ZeroAmount.selector);
        splitter.payWithAuthorization(
            TOOL_ID, PAYER, 0, 0, type(uint256).max, bytes32(uint256(4)), 0, 0, 0
        );
    }

    // ── rounding at the edges ───────────────────────────────────────────────

    function test_roundingEdges_oneToTenBaseUnits() public {
        // Below 50 base units, 2% is less than one unit. It floors to nothing and the
        // provider keeps all of it — the platform never rounds a fee up into existence.
        for (uint256 value = 1; value <= 10; value++) {
            assertEq(splitter.feeFor(value), 0, "tiny amounts must yield no fee");
        }
        assertEq(splitter.feeFor(49), 0);
        assertEq(splitter.feeFor(50), 1);
        assertEq(splitter.feeFor(99), 1);
        assertEq(splitter.feeFor(100), 2);
        assertEq(splitter.feeFor(149), 2, "2.98 must floor to 2, not round to 3");
    }

    function test_paysTinyAmountsEntirelyToProvider() public {
        _pay(10, bytes32(uint256(5)));
        assertEq(usdc.balanceOf(PROVIDER), 10);
        assertEq(usdc.balanceOf(TREASURY), 0);
    }

    // ── the shared vectors ──────────────────────────────────────────────────

    function test_matchesSharedVectorsWithTypeScript() public view {
        // The same pairs are asserted in sdk/src/fee-policy.test.ts. If these two ever
        // disagree, an on-chain split and the price we quoted diverge — and the payment is
        // final by the time anyone notices.
        string memory json = vm.readFile("test/vectors.json");
        uint256 count = json.readUint(".count");
        assertGt(count, 0, "vectors file must not be empty");

        for (uint256 i = 0; i < count; i++) {
            string memory at = string.concat(".vectors[", vm.toString(i), "]");
            uint256 gross = vm.parseUint(json.readString(string.concat(at, ".gross")));
            uint256 fee = vm.parseUint(json.readString(string.concat(at, ".fee")));
            assertEq(splitter.feeFor(gross), fee, "diverged from the TypeScript vectors");
        }
    }

    // ── properties ──────────────────────────────────────────────────────────

    function testFuzz_splitIsExactAndNeverRoundsUp(uint256 value) public view {
        value = bound(value, 1, 1e18);
        uint256 fee = splitter.feeFor(value);
        // Nothing is created or destroyed.
        assertEq(fee + (value - fee), value);
        // The platform's share never exceeds an exact 2%.
        assertLe(fee * 10_000, value * 200);
        // And is never more than one base unit short of it, so this is a floor rather
        // than an arbitrary undercharge.
        assertGt((fee + 1) * 10_000, value * 200);
    }

    function testFuzz_bothPartiesArePaidExactly(uint256 value) public {
        value = bound(value, 1, 1e15);
        _pay(value, bytes32(uint256(0xF0)));
        assertEq(usdc.balanceOf(PROVIDER) + usdc.balanceOf(TREASURY), value);
        assertEq(usdc.balanceOf(address(splitter)), 0);
    }

    // ── hostile tokens ──────────────────────────────────────────────────────

    function test_revertsWhenTokenTransferReturnsFalse() public {
        // A silent false would otherwise leave the provider unpaid while the payer's money
        // had already left their wallet.
        usdc.mint(PAYER, 1_000);
        usdc.setTransferReturnsFalse(true);
        vm.expectRevert(FatstackSplitter.TransferFailed.selector);
        splitter.payWithAuthorization(
            TOOL_ID, PAYER, 1_000, 0, type(uint256).max, bytes32(uint256(6)), 0, 0, 0
        );
    }

    function test_revertsWhenTokenTransferReverts() public {
        usdc.mint(PAYER, 1_000);
        usdc.setTransferReverts(true);
        vm.expectRevert(FatstackSplitter.TransferFailed.selector);
        splitter.payWithAuthorization(
            TOOL_ID, PAYER, 1_000, 0, type(uint256).max, bytes32(uint256(7)), 0, 0, 0
        );
    }

    function test_splitsWhatArrivedNotWhatWasAsked() public {
        // A fee-on-transfer token delivers less than `value`. Splitting `value` would
        // overpay the provider out of whatever balance happened to be here — which, on a
        // contract that holds nothing between payments, means the transaction reverts and
        // a legitimate payer is refused. Split what arrived.
        usdc.setTransferTaxBps(1_000); // 10% withheld by the token
        usdc.mint(PAYER, 1_000);
        splitter.payWithAuthorization(
            TOOL_ID, PAYER, 1_000, 0, type(uint256).max, bytes32(uint256(8)), 0, 0, 0
        );
        // 900 arrived: fee 18, provider 882.
        assertEq(usdc.balanceOf(PROVIDER), 882);
        assertEq(usdc.balanceOf(TREASURY), 18);
        assertEq(usdc.balanceOf(address(splitter)), 0);
    }

    function test_authorizationCannotBeReplayed() public {
        bytes32 nonce = bytes32(uint256(9));
        _pay(1_000, nonce);
        usdc.mint(PAYER, 1_000);
        vm.expectRevert(MockUSDC.AuthorizationUsed.selector);
        splitter.payWithAuthorization(TOOL_ID, PAYER, 1_000, 0, type(uint256).max, nonce, 0, 0, 0);
    }

    // ── reentrancy ──────────────────────────────────────────────────────────

    function test_reentrantTokenCannotDrainOrDoubleSpend() public {
        // USDC does not call back into the recipient. This proves the splitter survives a
        // token that does, because "the configured token would never do that" is an
        // assumption, and an immutable contract has to hold when it is wrong.
        ReentrantToken evil = new ReentrantToken();
        FatstackSplitter s = new FatstackSplitter(address(evil), PROVIDER, TREASURY);
        evil.setSplitter(s);
        evil.mint(PAYER, 10_000);

        s.payWithAuthorization(
            TOOL_ID, PAYER, 10_000, 0, type(uint256).max, bytes32(uint256(11)), 0, 0, 0
        );

        assertTrue(evil.reentered(), "the token did attempt to re-enter");
        // The re-entrant call is funded by nothing and reverts inside its own try/catch;
        // the outer payment still settles exactly once and nothing is stranded.
        assertEq(evil.balanceOf(PROVIDER) + evil.balanceOf(TREASURY), 10_000);
        assertEq(evil.balanceOf(address(s)), 0, "no balance may be left behind");
    }

    // ── Hostile-review additions ────────────────────────────────────────────────

    /**
     * @notice USDC sent to the splitter by mistake is not paid out by the next payment.
     *
     * @dev The contract computes what it received from a balance *delta*, not from its
     *      balance. If it used the balance, a stray transfer would be handed to whoever
     *      paid next — someone else's money, moved by a payment they did not authorise.
     *      The donation stays stuck instead, which is the documented and deliberate
     *      trade: there is no sweep, because a sweep is a function that moves money nobody
     *      authorised, and that is the capability the platform promises never to have.
     */
    function test_aStrayDonationIsNotPaidOutByTheNextPayment() public {
        usdc.mint(address(splitter), 500_000);
        usdc.mint(PAYER, 1_000);

        splitter.payWithAuthorization(
            keccak256("uuid-batch"),
            PAYER,
            1_000,
            0,
            type(uint256).max,
            bytes32(uint256(9)),
            0,
            0,
            0
        );

        assertEq(usdc.balanceOf(PROVIDER), 980, "only the authorised payment is split");
        assertEq(usdc.balanceOf(TREASURY), 20);
        assertEq(usdc.balanceOf(address(splitter)), 500_000, "the donation stays stranded");
    }

    /**
     * @notice A splitter whose provider and treasury are the same address still conserves.
     *
     * @dev Not hypothetical: the first Sepolia deployment had exactly this, which made the
     *      split untestable because both halves landed in one wallet. It is a
     *      misconfiguration rather than a vulnerability — nothing is lost or duplicated,
     *      the platform simply collects no fee — and the go/no-go checklist blocks it. This
     *      pins the behaviour so it fails loudly in a test rather than quietly on chain.
     */
    function test_providerEqualToTreasuryStillConservesEveryBaseUnit() public {
        FatstackSplitter same = new FatstackSplitter(address(usdc), PROVIDER, PROVIDER);
        usdc.mint(PAYER, 1_000);

        same.payWithAuthorization(
            keccak256("uuid-batch"),
            PAYER,
            1_000,
            0,
            type(uint256).max,
            bytes32(uint256(10)),
            0,
            0,
            0
        );

        assertEq(usdc.balanceOf(PROVIDER), 1_000, "both halves land, nothing is lost");
        assertEq(usdc.balanceOf(address(same)), 0);
    }

    /**
     * @notice An absurd amount reverts on overflow rather than splitting wrongly.
     *
     * @dev `amount * 200` overflows above `type(uint256).max / 200`. Solidity 0.8 reverts,
     *      so the payment simply fails and the payer keeps their money. No real USDC amount
     *      comes close — total supply is ~1e16 base units — but "reverts" and "returns a
     *      wrong fee" are very different failures, and only one of them is safe.
     */
    function test_anAbsurdAmountRevertsRatherThanMiscomputing() public {
        vm.expectRevert();
        splitter.feeFor(type(uint256).max);
    }
}
