// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.7 <0.9.0;

import '../../DCAFeeManager/DCAFeeManager.sol';

contract DCAFeeManagerMock is DCAFeeManager {
  constructor(
    IWrappedProtocolToken _wToken,
    address _superAdmin,
    address[] memory _initialAdmins
  ) DCAFeeManager(_wToken, _superAdmin, _initialAdmins) {}

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
