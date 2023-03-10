import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from '@0xged/hardhat-deploy/types';
import { bytecode } from '../artifacts/contracts/DCAHubSwapper/CallerOnlyDCAHubSwapper.sol/CallerOnlyDCAHubSwapper.json';
import { deployThroughDeterministicFactory } from '@mean-finance/deterministic-factory/utils/deployment';

const deployFunction: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer, msig } = await hre.getNamedAccounts();

  const swapperRegistry = await hre.deployments.get('SwapperRegistry');

  await deployThroughDeterministicFactory({
    deployer,
    name: 'CallerOnlyDCAHubSwapper',
    salt: 'MF-DCAV2-CallerDCAHubSwapper-V1',
    contract: 'contracts/DCAHubSwapper/CallerOnlyDCAHubSwapper.sol:CallerOnlyDCAHubSwapper',
    bytecode,
    constructorArgs: {
      types: ['address', 'address', 'address[]', 'address[]'],
      values: [swapperRegistry.address, msig, [msig], []],
    },
    log: !process.env.TEST,
    overrides: !!process.env.COVERAGE
      ? {}
      : {
          gasLimit: 6_000_000,
        },
  });
};

deployFunction.dependencies = [];
deployFunction.tags = ['CallerOnlyDCAHubSwapper'];
export default deployFunction;