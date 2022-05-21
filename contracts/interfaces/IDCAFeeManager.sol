// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.8.7 <0.9.0;

import '@mean-finance/dca-v2-core/contracts/interfaces/IDCAHub.sol';
import './IWrappedProtocolToken.sol';
import './utils/IGovernable.sol';

/**
 * @title DCA Fee Manager
 * @notice This contract will manage all platform fees. Since fees come in different tokens, this manager
 *         will be in charge of taking them and converting them to different tokens, for example ETH/MATIC
 *         or stablecoins. Allowed users will to withdraw fees as generated, or DCA them into tokens
 *         of their choosing
 */
interface IDCAFeeManager is IGovernable {
  /// @notice Represents a share of a target token
  struct TargetTokenShare {
    address token;
    uint16 shares;
  }

  /// @notice Thrown when a user tries to set an invalid distribution
  error InvalidAmountOfShares();

  /**
   * @notice Emitted when a new distribution is set
   * @param distribution The new distribution
   */
  event NewDistribution(TargetTokenShare[] distribution);

  /**
   * @notice The contract's owner and other allowed users can specify the target tokens that the fees
   *         should be converted to. They can also specify the percentage assigned to each token
   * @dev This value is constant and cannot be modified
   * @return The numeric value that represents a 100% asignment for the fee conversion distribution
   */
  // solhint-disable-next-line func-name-mixedcase
  function MAX_TOKEN_TOTAL_SHARE() external view returns (uint16);

  /**
   * @notice Returns the swap interval used for DCA swaps
   * @dev This value is constant and cannot be modified
   * @return The swap interval used for DCA swaps
   */
  // solhint-disable-next-line func-name-mixedcase
  function SWAP_INTERVAL() external view returns (uint32);

  /**
   * @notice Returns address for the DCA Hub
   * @dev This value cannot be modified after deployment
   * @return The address for the DCA Hub
   */
  function hub() external view returns (IDCAHub);

  /**
   * @notice Returns the distribution for the target tokens. Target tokens are the tokens that we
   *         want to swap the fees to. We can assign a distribution to convert to many different tokens
   * @return The distribution for the target tokens
   */
  function targetTokensDistribution() external view returns (TargetTokenShare[] memory);

  /**
   * @notice Sets the distribution for the target tokens
   * @dev Can only be set by the owner or allowed users
   * @param distribution The new distribution to set
   */
  function setTargetTokensDistribution(TargetTokenShare[] calldata distribution) external;
}