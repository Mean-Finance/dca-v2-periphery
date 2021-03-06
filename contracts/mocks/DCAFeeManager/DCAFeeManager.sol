// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.7 <0.9.0;

import '../../DCAFeeManager/DCAFeeManager.sol';

contract DCAFeeManagerMock is DCAFeeManager {
  constructor(
    IDCAHub _hub,
    IWrappedProtocolToken _wToken,
    address _governor
  ) DCAFeeManager(_hub, _wToken, _governor) {}

  function setPosition(
    address _from,
    address _to,
    uint256 _positionId
  ) external {
    positions[getPositionKey(_from, _to)] = _positionId;
  }

  function positionsWithToken(address _toToken) external view returns (uint256[] memory) {
    return _positionsWithToken[_toToken];
  }

  function setPositionsWithToken(address _toToken, uint256[] calldata _positionIds) external {
    for (uint256 i; i < _positionIds.length; i++) {
      _positionsWithToken[_toToken].push(_positionIds[i]);
    }
  }
}
