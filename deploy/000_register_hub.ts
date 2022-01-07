import { abi as DCA_HUB_ABI, bytecode as DCA_HUB_BYTECODE } from '@mean-finance/dca-v2-core/artifacts/contracts/DCAHub/DCAHub.sol/DCAHub.json';
import {
  abi as PM_ABI,
  bytecode as PM_BYTECODE,
} from '@mean-finance/dca-v2-core/artifacts/contracts/DCAPermissionsManager/DCAPermissionsManager.sol/DCAPermissionsManager.json';
import {
  abi as CHAINLINK_ABI,
  bytecode as CHAINLINK_BYTECODE,
} from '@mean-finance/dca-v2-core/artifacts/contracts/oracles/ChainlinkOracle.sol/ChainlinkOracle.json';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { BigNumber } from 'ethers/lib/ethers';

const deployFunction: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  let hub: string;
  switch (hre.network.name) {
    case 'hardhat':
    case 'optimism':
      // TODO: Update to non-beta deployment
      hub = '0x24F85583FAa9F8BD0B8Aa7B1D1f4f53F0F450038';
      break;
    case 'optimism-kovan':
      hub = '0x2aCb69a8f2Ab6b496D482073eB70573A345a3272';
      break;
    default:
      throw new Error(`Unsupported chain '${hre.network.name}`);
  }

  const isDeployed = (await hre.ethers.provider.getCode(hub)) !== '0x';
  if (isDeployed) {
    await hre.deployments.save('DCAHub', { abi: DCA_HUB_ABI, address: hub });
  } else {
    // TODO: Once the final version of the hub is deployed everywhere, remove all this
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const CHAINLINK_REGISTRY = '0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf';
    const DCA_TOKEN_DESCRIPTOR = '0x0000000000000000000000000000000000000001';
    const { deployer, governor } = await hre.getNamedAccounts();
    const chainlinkDeployment = await hre.deployments.deploy('Oracle', {
      from: deployer,
      contract: { abi: CHAINLINK_ABI, bytecode: CHAINLINK_BYTECODE },
      args: [WETH, CHAINLINK_REGISTRY, BigNumber.from(2).pow(32).sub(1), governor],
    });
    const permissionsManagerDeployment = await hre.deployments.deploy('PermissionsManager', {
      from: deployer,
      contract: { abi: PM_ABI, bytecode: PM_BYTECODE },
      args: [governor, DCA_TOKEN_DESCRIPTOR],
    });
    const hubDeployment = await hre.deployments.deploy('DCAHub', {
      from: deployer,
      contract: { abi: DCA_HUB_ABI, bytecode: DCA_HUB_BYTECODE },
      args: [governor, governor, chainlinkDeployment.address, permissionsManagerDeployment.address],
    });
    await hre.deployments.execute('PermissionsManager', { from: deployer }, 'setHub', hubDeployment.address);
    return;
  }
};
deployFunction.tags = ['DCAHub'];
export default deployFunction;
