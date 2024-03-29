import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from '@0xged/hardhat-deploy/types';
import { bytecode } from '../artifacts/contracts/DCAFeeManager/DCAFeeManager.sol/DCAFeeManager.json';
import { deployThroughDeterministicFactory } from '@mean-finance/deterministic-factory/utils/deployment';

const deployFunction: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer, msig } = await hre.getNamedAccounts();

  await deployThroughDeterministicFactory({
    deployer,
    name: 'DCAFeeManager',
    salt: 'MF-DCAV2-DCAFeeManager-V3',
    contract: 'contracts/DCAFeeManager/DCAFeeManager.sol:DCAFeeManager',
    bytecode,
    constructorArgs: {
      types: ['address', 'address[]'],
      values: [msig, [msig]],
    },
    log: !process.env.TEST,
    overrides: !!process.env.COVERAGE
      ? {}
      : {
          gasLimit: 4_000_000,
        },
  });
};

deployFunction.tags = ['DCAFeeManager'];
export default deployFunction;
