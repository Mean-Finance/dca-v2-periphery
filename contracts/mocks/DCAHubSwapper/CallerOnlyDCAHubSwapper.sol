// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.22;

import '../../DCAHubSwapper/CallerOnlyDCAHubSwapper.sol';

contract CallerOnlyDCAHubSwapperMock is CallerOnlyDCAHubSwapper {
  function isSwapExecutorEmpty() external view returns (bool) {
    return _swapExecutor == _NO_EXECUTOR;
  }

  function setSwapExecutor(address _newSwapExecutor) external {
    _swapExecutor = _newSwapExecutor;
  }
}
