// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.8.7 <0.9.0;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import './DCAHubCompanionParameters.sol';

abstract contract DCAHubCompanionWTokenPositionHandler is DCAHubCompanionParameters, IDCAHubCompanionWTokenPositionHandler {
  // solhint-disable-next-line private-vars-leading-underscore
  address private constant PROTOCOL_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

  function depositUsingProtocolToken(
    address _to,
    uint256 _amount,
    uint32 _amountOfSwaps,
    uint32 _swapInterval,
    address _owner,
    IDCAPermissionManager.PermissionSet[] calldata _permissions
  ) external payable returns (uint256 _positionId) {
    _wrapAndApprove(_amount);
    _positionId = hub.deposit(address(wToken), _to, _amount, _amountOfSwaps, _swapInterval, _owner, _addPermissionsThisContract(_permissions));
    emit ConvertedDeposit(_positionId, PROTOCOL_TOKEN, address(wToken));
  }

  function withdrawSwappedUsingProtocolToken(uint256 _positionId, address payable _recipient) external returns (uint256 _swapped) {
    _swapped = hub.withdrawSwapped(_positionId, address(this));
    _unwrapAndSend(_swapped, _recipient);
  }

  function increasePositionUsingProtocolToken(
    uint256 _positionId,
    uint256 _amount,
    uint32 _newSwaps
  ) external payable {
    _wrapAndApprove(_amount);
    hub.increasePosition(_positionId, _amount, _newSwaps);
  }

  function _unwrapAndSend(uint256 _amount, address payable _recipient) internal {
    // Unwrap wToken
    wToken.withdraw(_amount);

    // Send protocol token to recipient
    _recipient.transfer(_amount);
  }

  function _wrapAndApprove(uint256 _amount) internal {
    // Convert to wToken
    wToken.deposit{value: _amount}();

    // Approve token for the hub
    wToken.approve(address(hub), _amount);
  }

  function _addPermissionsThisContract(IDCAPermissionManager.PermissionSet[] calldata _permissionSets)
    internal
    view
    returns (IDCAPermissionManager.PermissionSet[] memory _newPermissionSets)
  {
    // Copy permission sets to the new array
    _newPermissionSets = new IDCAPermissionManager.PermissionSet[](_permissionSets.length + 1);
    for (uint256 i; i < _permissionSets.length; i++) {
      _newPermissionSets[i] = _permissionSets[i];
    }

    // Create new list that contains all permissions
    IDCAPermissionManager.Permission[] memory _permissions = new IDCAPermissionManager.Permission[](4);
    for (uint256 i; i < 4; i++) {
      _permissions[i] = IDCAPermissionManager.Permission(i);
    }

    // Assign all permisisons to this contract
    _newPermissionSets[_permissionSets.length] = IDCAPermissionManager.PermissionSet({operator: address(this), permissions: _permissions});
  }
}
