// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FatstackSplitter} from "../src/FatstackSplitter.sol";

interface IUSDC {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/**
 * @notice Exercises the splitter against the real USDC contract on a Base fork.
 *
 * @dev The unit tests use a mock, which is honest about arithmetic and silent about the
 *      thing that actually matters here: whether the real token's
 *      `receiveWithAuthorization` behaves the way this contract assumes. That assumption
 *      is the whole design, and a mock can only ever confirm what it was written to
 *      confirm.
 *
 *      Skipped when no RPC is configured, and it says so rather than passing quietly —
 *      a fork test that silently no-ops is worse than none, because it reads as coverage.
 *
 *      Run: `BASE_RPC_URL=... forge test --match-contract Fork -vv`
 */
contract FatstackSplitterForkTest is Test {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant TREASURY = address(0x7EA5);
    address internal constant PROVIDER = address(0xA11CE);

    /// @dev EIP-712 type hash USDC uses for `receiveWithAuthorization`.
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    FatstackSplitter internal splitter;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        splitter = new FatstackSplitter(USDC, PROVIDER, TREASURY);
    }

    function test_realUsdcSplitArithmetic() public {
        if (!forked) {
            // vm.skip, never a silent return. A `return` here counts as a pass, so the
            // suite reports 34 green while four tests did nothing — which is how the
            // go/no-go came to claim a fork test against real USDC that had not run.
            // SECURITY.md: silence from a check must be indistinguishable from failure,
            // never from a pass.
            vm.skip(true);
        }

        // The fee expression, evaluated by a contract deployed against the real token.
        assertEq(splitter.feeFor(1_000_000), 20_000);
        assertEq(splitter.feeFor(149), 2);
        assertEq(splitter.feeFor(49), 0);
        assertEq(splitter.USDC(), USDC);
    }

    /**
     * @notice A real, signed EIP-3009 payment through real USDC, split for real.
     *
     * @dev This is the test the mock cannot be: it signs the authorisation the way an
     *      agent's wallet does, hands it to the deployed token, and checks the balances
     *      the token itself produced. Everything the design assumes about
     *      `receiveWithAuthorization` — that the recipient must be the caller, that the
     *      signature recovers, that the nonce burns — is exercised here or nowhere.
     */
    function test_signedAuthorizationSplitsRealUsdc() public {
        if (!forked) {
            // vm.skip, never a silent return. A `return` here counts as a pass, so the
            // suite reports 34 green while four tests did nothing — which is how the
            // go/no-go came to claim a fork test against real USDC that had not run.
            // SECURITY.md: silence from a check must be indistinguishable from failure,
            // never from a pass.
            vm.skip(true);
        }

        uint256 payerKey = 0xA11CE5EED;
        address payer = vm.addr(payerKey);
        uint256 value = 1_000_000; // $1.00

        // `deal` writes the balance directly, so the test needs no funded account of its
        // own and cannot rot when some whale address moves its holdings.
        deal(USDC, payer, value);
        assertEq(IUSDC(USDC).balanceOf(payer), value);

        // Deltas, not absolute balances. These are real addresses on a real chain and some
        // of them already hold USDC — an absolute assertion here passes or fails on the
        // history of a third party rather than on anything this contract did.
        uint256 providerBefore = IUSDC(USDC).balanceOf(PROVIDER);
        uint256 treasuryBefore = IUSDC(USDC).balanceOf(TREASURY);

        bytes32 nonce = keccak256("fatstack-fork-test");
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_TYPEHASH, payer, address(splitter), value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", IUSDC(USDC).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);

        splitter.payWithAuthorization(
            keccak256("uuid-batch"), payer, value, validAfter, validBefore, nonce, v, r, s
        );

        assertEq(IUSDC(USDC).balanceOf(PROVIDER) - providerBefore, 980_000, "provider receives 98%");
        assertEq(
            IUSDC(USDC).balanceOf(TREASURY) - treasuryBefore, 20_000, "treasury receives floor(2%)"
        );
        assertEq(IUSDC(USDC).balanceOf(address(splitter)), 0, "nothing may be left behind");
        assertEq(IUSDC(USDC).balanceOf(payer), 0, "payer paid exactly the authorised amount");
        assertTrue(
            IUSDC(USDC).authorizationState(payer, nonce), "the nonce must be burned once used"
        );
    }

    function test_theSameAuthorizationCannotBeReplayed() public {
        if (!forked) {
            // vm.skip, never a silent return. A `return` here counts as a pass, so the
            // suite reports 34 green while four tests did nothing — which is how the
            // go/no-go came to claim a fork test against real USDC that had not run.
            // SECURITY.md: silence from a check must be indistinguishable from failure,
            // never from a pass.
            vm.skip(true);
        }

        uint256 payerKey = 0xBEEFCAFE;
        address payer = vm.addr(payerKey);
        deal(USDC, payer, 2_000_000);

        bytes32 nonce = keccak256("fatstack-replay-test");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, payer, address(splitter), 1_000_000, 0, validBefore, nonce)
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", IUSDC(USDC).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);

        splitter.payWithAuthorization(bytes32(0), payer, 1_000_000, 0, validBefore, nonce, v, r, s);

        // Replaying a settled payment must fail at the token, not merely be unprofitable.
        vm.expectRevert();
        splitter.payWithAuthorization(bytes32(0), payer, 1_000_000, 0, validBefore, nonce, v, r, s);
    }

    function test_splitterHoldsNothingByDefault() public {
        if (!forked) {
            // vm.skip, never a silent return. A `return` here counts as a pass, so the
            // suite reports 34 green while four tests did nothing — which is how the
            // go/no-go came to claim a fork test against real USDC that had not run.
            // SECURITY.md: silence from a check must be indistinguishable from failure,
            // never from a pass.
            vm.skip(true);
        }
        assertEq(IUSDC(USDC).balanceOf(address(splitter)), 0);
    }
}
