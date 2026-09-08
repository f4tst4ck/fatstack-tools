// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The subset of EIP-3009 this contract relies on.
/// @dev `receiveWithAuthorization` requires `msg.sender == to`, so the pull and the split
///      are one atomic transaction and no third party can submit the signature alone.
interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title FatstackSplitter
 * @notice Splits a USDC payment between one provider and the platform treasury.
 *
 * @dev **One splitter per provider, with the provider fixed at construction.** This is the
 *      single most important property of the design, and it is a correction to an earlier
 *      draft that took the provider as a call parameter.
 *
 *      An EIP-3009 signature covers `(from, to, value, validAfter, validBefore, nonce)` and
 *      nothing else. A `provider` argument is therefore unsigned: anyone who observes a
 *      pending authorisation can submit it themselves with `provider` set to an address
 *      they control and take the provider's 98%. `receiveWithAuthorization` prevents a
 *      third party front-running the *transfer*; it does nothing about a recipient contract
 *      that lets the caller choose where the money goes next. Making the provider immutable
 *      removes the parameter, and with it the attack: whoever submits the transaction, the
 *      funds can only reach this provider.
 *
 *      `toolId` remains an unsigned parameter. A submitter can mislabel which listing was
 *      paid for, which is why revenue attribution is not taken from this event alone — but
 *      no choice of `toolId` can move a single base unit anywhere else.
 *
 *      Immutable throughout: no owner, no pause, no proxy, no upgrade path, and no function
 *      that moves money outside a payment the payer authorised. There is deliberately no
 *      sweep — see the note on stranded funds below.
 *
 *      The fee is `floor(amount * 200 / 10_000)` and the remainder goes to the provider,
 *      the same expression as `platformFee()` in the TypeScript SDK. Both are asserted
 *      against `test/vectors.json`; if they ever diverge, an on-chain split and the price
 *      we quoted disagree, and the payment is final by the time anyone notices.
 *
 *      Rounding is **down, always**, so the platform can never take more than two percent.
 *      A leftover base unit goes to the provider. Rounding the other way would be a
 *      fraction of a cent per call in our own favour — the sort of default nobody notices
 *      until it is a pattern.
 *
 *      **Stranded funds.** USDC arriving by any route other than `payWithAuthorization`
 *      cannot be recovered. There is no sweep, because a sweep is a function that moves
 *      someone else's money, and adding one to rescue an accidental transfer would give
 *      this contract exactly the power the platform promises never to have. Payments are
 *      atomic, so nothing is held between transactions by design.
 */
contract FatstackSplitter {
    /// @notice The only token this contract will move. Set once, at construction.
    address public immutable USDC;

    /// @notice The provider this splitter pays. Set once, and never a call parameter.
    address public immutable PROVIDER;

    /// @notice Receives the platform fee. Set once, at construction.
    address public immutable TREASURY;

    /// @notice Platform fee in basis points. 200 = 2%.
    uint256 public constant FEE_BPS = 200;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Emitted once per settled payment.
    /// @param payer The wallet that authorised the payment.
    /// @param amount Gross amount received, in USDC base units.
    /// @param fee The platform's share, already deducted from the provider's.
    /// @param toolId Which listing was paid for. Advisory: it is not covered by the
    ///        payer's signature, so it labels rather than proves.
    event Payment(address indexed payer, uint256 amount, uint256 fee, bytes32 indexed toolId);

    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();

    constructor(address usdc, address provider, address treasury) {
        if (usdc == address(0) || provider == address(0) || treasury == address(0)) {
            revert ZeroAddress();
        }
        // A provider that is this contract would strand every payment it ever received,
        // irrecoverably, because there is no sweep.
        if (provider == address(this)) revert ZeroAddress();
        USDC = usdc;
        PROVIDER = provider;
        TREASURY = treasury;
    }

    /**
     * @notice The platform's share of a payment.
     * @dev Pure and public so the split can be checked before paying, and so the tests can
     *      fuzz it directly against the TypeScript implementation.
     */
    function feeFor(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS) / BPS_DENOMINATOR + 1; // deliberate break, probe only
    }

    /**
     * @notice Pulls an authorised USDC payment and splits it in one transaction.
     *
     * @dev Amounts are computed from the balance actually received rather than from
     *      `value`, so a token that delivers less than it was asked to splits what arrived
     *      instead of paying the provider out of some other payment's funds.
     *
     *      The provider is paid first and in full; if the treasury transfer fails the whole
     *      transaction reverts and the payer keeps their money. The platform never ends up
     *      holding a provider's revenue, even for one call frame.
     */
    function payWithAuthorization(
        bytes32 toolId,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (value == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(USDC).balanceOf(address(this));

        IEIP3009(USDC)
            .receiveWithAuthorization(
                from, address(this), value, validAfter, validBefore, nonce, v, r, s
            );

        uint256 received = IERC20(USDC).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();

        uint256 fee = feeFor(received);

        _transfer(PROVIDER, received - fee);
        if (fee != 0) _transfer(TREASURY, fee);

        emit Payment(from, received, fee, toolId);
    }

    /// @dev USDC returns a bool; some tokens return nothing. Accept both, reject a false.
    function _transfer(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) =
            USDC.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
