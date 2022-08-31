// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.8.7 <0.9.0;

import './DCAStrategiesPositionsHandler.sol';

contract DCAStrategies is DCAStrategiesPositionsHandler {
  constructor(
    address _governor,
    IDCAHubPositionDescriptor _descriptor,
    uint8 _maxTokenShares
  )
    ERC721('Mean Finance - DCA Strategy Position', 'MF-DCA-STRAT-P')
    EIP712('Mean Finance - DCA Strategy Position', '1')
    Governable(_governor)
    DCAStrategiesPermissionsHandler(_descriptor)
    DCAStrategiesManagementHandler(_maxTokenShares)
  {}
}
