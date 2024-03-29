import { expect } from 'chai';
import { ethers } from 'hardhat';
import { TransactionResponse } from '@ethersproject/providers';
import { constants, wallet } from '@test-utils';
import { given, then, when } from '@test-utils/bdd';
import evm, { snapshot } from '@test-utils/evm';
import { IERC20, DCAHubCompanion, LegacyDCASwapper, LegacyDCASwapper__factory } from '@typechained';
import { DCAHub } from '@mean-finance/dca-v2-core';
import { StatefulChainlinkOracle } from '@mean-finance/oracles';
import { ChainlinkRegistry } from '@mean-finance/chainlink-registry';
import { abi as DCA_HUB_ABI } from '@mean-finance/dca-v2-core/artifacts/contracts/DCAHub/DCAHub.sol/DCAHub.json';
import { abi as IERC20_ABI } from '@openzeppelin/contracts/build/contracts/IERC20.json';
import { BigNumber, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { SwapInterval } from '@test-utils/interval-utils';
import forkBlockNumber from '@integration/fork-block-numbers';
import { fromRpcSig } from 'ethereumjs-util';
import { deployWithAddress } from '@integration/utils';

const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS = '0x7f5c764cbc14f9669b88837ca1490cca17c31607';
const WETH_WHALE_ADDRESS = '0xaa30d6bba6285d0585722e2440ff89e23ef68864';
const USDC_WHALE_ADDRESS = '0xad7b4c162707e0b2b5f6fddbd3f8538a5fba0d60';
const BETA_HUB = '0x24F85583FAa9F8BD0B8Aa7B1D1f4f53F0F450038';
const VULN_HUB = '0x230C63702D1B5034461ab2ca889a30E343D81349';
const YIELDLESS_HUB = '0x059d306A25c4cE8D7437D25743a8B94520536BD5';
const NAME_AND_VERSION: Record<string, { name: string; version: string }> = {
  [BETA_HUB]: { name: 'Mean Finance DCA', version: '1' },
  [VULN_HUB]: { name: 'Mean Finance DCA', version: '1' },
  [YIELDLESS_HUB]: { name: 'Mean Finance - DCA Position', version: '1' },
};

describe('Position Migration', () => {
  let WETH: IERC20, USDC: IERC20;
  let positionOwner: SignerWithAddress, swapper: SignerWithAddress;
  let vulnDCAHub: DCAHub, betaDCAHub: DCAHub, yieldlessDCAHub: DCAHub, DCAHub: DCAHub;
  let DCAHubCompanion: DCAHubCompanion, legacyDCAHubSwapper: LegacyDCASwapper;
  let snapshotId: string;
  let chainId: BigNumber;

  const RATE = BigNumber.from(100000000);
  const AMOUNT_OF_SWAPS = 10;

  before(async () => {
    await evm.reset({
      network: 'optimism',
      blockNumber: forkBlockNumber['position-migrator'],
    });
    [positionOwner, swapper] = await ethers.getSigners();

    const { msig, eoaAdmin } = await deployWithAddress('0x308810881807189cAe91950888b2cB73A1CC5920', 'DCAHubCompanion');

    // Hardhat deploy does not reset addresses in each test, so it's not taking the correct msig for optimismi
    const optimismMsig = await wallet.impersonate('0x308810881807189cAe91950888b2cB73A1CC5920');
    await ethers.provider.send('hardhat_setBalance', [optimismMsig._address, '0xffffffffffffffff']);

    DCAHub = await ethers.getContract('DCAHub');
    DCAHubCompanion = await ethers.getContract('DCAHubCompanion');
    betaDCAHub = await ethers.getContractAt(DCA_HUB_ABI, BETA_HUB);
    vulnDCAHub = await ethers.getContractAt(DCA_HUB_ABI, VULN_HUB);
    yieldlessDCAHub = await ethers.getContractAt(DCA_HUB_ABI, YIELDLESS_HUB);
    const chainlinkRegistry = await ethers.getContract<ChainlinkRegistry>('ChainlinkFeedRegistry');
    const chainlinkOracle = await ethers.getContract<StatefulChainlinkOracle>('StatefulChainlinkOracle');

    // Unpause
    await vulnDCAHub.connect(eoaAdmin).unpause();
    await betaDCAHub.connect(eoaAdmin).unpause();

    // Allow one minute interval
    await betaDCAHub.connect(eoaAdmin).addSwapIntervalsToAllowedList([SwapInterval.ONE_MINUTE.seconds]);
    await vulnDCAHub.connect(eoaAdmin).addSwapIntervalsToAllowedList([SwapInterval.ONE_MINUTE.seconds]);
    await yieldlessDCAHub.connect(optimismMsig).addSwapIntervalsToAllowedList([SwapInterval.ONE_MINUTE.seconds]);
    await DCAHub.connect(msig).addSwapIntervalsToAllowedList([SwapInterval.ONE_MINUTE.seconds]);

    // Allow tokens
    await yieldlessDCAHub.connect(optimismMsig).setAllowedTokens([WETH_ADDRESS, USDC_ADDRESS], [true, true]);
    await DCAHub.connect(msig).setAllowedTokens([WETH_ADDRESS, USDC_ADDRESS], [true, true]);

    // Configure chainlink registry & oracle so it can be used (Uniswap takes a lot longer to configure)
    const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const USD = '0x0000000000000000000000000000000000000348';
    await chainlinkRegistry.connect(msig).assignFeeds([{ base: ETH, quote: USD, feed: '0x13e3Ee699D1909E989722E753853AE30b17e08c5' }]);
    await chainlinkOracle.connect(msig).addMappings([WETH_ADDRESS, USDC_ADDRESS], [ETH, USD]);

    WETH = await ethers.getContractAt(IERC20_ABI, WETH_ADDRESS);
    USDC = await ethers.getContractAt(IERC20_ABI, USDC_ADDRESS);

    // Send tokens from whales, to our users
    await distributeTokensToUsers();

    chainId = BigNumber.from((await ethers.provider.getNetwork()).chainId);

    const legacyDCAHubSwapperFactory: LegacyDCASwapper__factory = await ethers.getContractFactory('LegacyDCASwapper');
    legacyDCAHubSwapper = await legacyDCAHubSwapperFactory.deploy();
    snapshotId = await snapshot.take();
  });

  beforeEach(async () => {
    await snapshot.revert(snapshotId);
  });

  migratePositionTest({
    title: 'migrating from beta version',
    sourceHub: () => betaDCAHub,
    targetHub: () => DCAHub,
  });

  migratePositionTest({
    title: 'migrating from vulnerable version',
    sourceHub: () => vulnDCAHub,
    targetHub: () => DCAHub,
  });

  migratePositionTest({
    title: 'migrating from yieldless version',
    sourceHub: () => yieldlessDCAHub,
    targetHub: () => DCAHub,
  });

  function migratePositionTest({ title, sourceHub, targetHub }: { title: string; sourceHub: () => DCAHub; targetHub: () => DCAHub }) {
    when(title, () => {
      let sourcePositionId: BigNumber, targetPositionId: BigNumber;
      let swappedBalance: BigNumber, unswappedBalance: BigNumber;
      given(async () => {
        ({ positionId: sourcePositionId, swappedBalance, unswappedBalance } = await depositInHubAndSwap(sourceHub()));
        const signature = await generateSignature(sourceHub(), positionOwner, sourcePositionId);
        const position = await sourceHub().userPosition(sourcePositionId);
        const { data: permissionData } = await DCAHubCompanion.populateTransaction.permissionPermit(
          await sourceHub().permissionManager(),
          signature.permissions,
          sourcePositionId,
          signature.deadline,
          signature.v,
          signature.r,
          signature.s
        );
        const { data: terminateData } = await DCAHubCompanion.populateTransaction.terminate(
          sourceHub().address,
          sourcePositionId,
          DCAHubCompanion.address,
          positionOwner.address
        );
        const { data: depositData } = await DCAHubCompanion.populateTransaction.depositWithBalanceOnContract(
          targetHub().address,
          position.from,
          position.to,
          position.swapsLeft,
          position.swapInterval,
          positionOwner.address,
          [],
          []
        );
        const tx = await DCAHubCompanion.multicall([permissionData!, terminateData!, depositData!]);
        const event = await getHubEvent(tx, 'Deposited');
        targetPositionId = event.args.positionId;
      });
      then('position is terminated', async () => {
        const userPosition = await sourceHub().userPosition(sourcePositionId);
        expect(userPosition.swapInterval).to.equal(0);
      });
      then('owner gets the swapped balance', async () => {
        const balance = await WETH.balanceOf(positionOwner.address);
        expect(balance).to.equal(swappedBalance);
        expect(balance.gt(0)).to.be.true;
      });
      then('new position is created on target hub', async () => {
        const { from, to, swapInterval, swapsExecuted, swapped, swapsLeft, remaining, rate } = await targetHub().userPosition(targetPositionId);
        expect(from.toLowerCase()).to.equal(USDC.address.toLowerCase());
        expect(to.toLowerCase()).to.equal(WETH.address.toLowerCase());
        expect(swapInterval).to.equal(SwapInterval.ONE_MINUTE.seconds);
        expect(swapsExecuted).to.equal(0);
        expect(swapped).to.equal(0);
        expect(swapsLeft).to.equal(AMOUNT_OF_SWAPS - 1);
        expect(remaining).to.equal(unswappedBalance);
        expect(rate).to.equal(RATE);
      });
    });
  }

  async function distributeTokensToUsers() {
    const wethWhale = await wallet.impersonate(WETH_WHALE_ADDRESS);
    const usdcWhale = await wallet.impersonate(USDC_WHALE_ADDRESS);
    await ethers.provider.send('hardhat_setBalance', [WETH_WHALE_ADDRESS, '0xffffffffffffffff']);
    await ethers.provider.send('hardhat_setBalance', [USDC_WHALE_ADDRESS, '0xffffffffffffffff']);
    await WETH.connect(wethWhale).transfer(swapper.address, BigNumber.from(10).pow(19));
    await USDC.connect(usdcWhale).transfer(positionOwner.address, BigNumber.from(10).pow(12));
  }

  async function depositInHubAndSwap(hub: DCAHub) {
    await USDC.connect(positionOwner).approve(hub.address, constants.MAX_UINT_256);
    const tx = await hub
      .connect(positionOwner)
      ['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'](
        USDC.address,
        WETH.address,
        RATE.mul(AMOUNT_OF_SWAPS),
        AMOUNT_OF_SWAPS,
        SwapInterval.ONE_MINUTE.seconds,
        positionOwner.address,
        []
      );
    const event = await getHubEvent(tx, 'Deposited');
    const positionId = event.args.positionId;

    await WETH.connect(swapper).approve(legacyDCAHubSwapper.address, constants.MAX_UINT_256);
    await legacyDCAHubSwapper
      .connect(swapper)
      .swapForCaller(hub.address, [WETH_ADDRESS, USDC_ADDRESS], [{ indexTokenA: 0, indexTokenB: 1 }], swapper.address);

    const { swapped } = await hub.userPosition(positionId);
    return { positionId, swappedBalance: swapped, unswappedBalance: RATE.mul(AMOUNT_OF_SWAPS - 1) };
  }

  function getHubEvent(tx: TransactionResponse, name: string): Promise<utils.LogDescription> {
    return findLogs(tx, new utils.Interface(DCA_HUB_ABI), name);
  }

  async function findLogs(
    tx: TransactionResponse,
    contractInterface: utils.Interface,
    eventTopic: string,
    extraFilter?: (_: utils.LogDescription) => boolean
  ): Promise<utils.LogDescription> {
    const txReceipt = await tx.wait();
    const logs = txReceipt.logs;
    for (let i = 0; i < logs.length; i++) {
      for (let x = 0; x < logs[i].topics.length; x++) {
        if (logs[i].topics[x] === contractInterface.getEventTopic(eventTopic)) {
          const parsedLog = contractInterface.parseLog(logs[i]);
          if (!extraFilter || extraFilter(parsedLog)) {
            return parsedLog;
          }
        }
      }
    }
    return Promise.reject();
  }

  async function generateSignature(sourceHub: DCAHub, signer: SignerWithAddress, tokenId: BigNumber) {
    const permissions = [{ operator: DCAHubCompanion.address, permissions: [Permission.TERMINATE] }];
    const { v, r, s } = await getSignature(sourceHub, signer, tokenId, permissions);
    return {
      permissions,
      deadline: constants.MAX_UINT_256,
      v,
      r,
      s,
    };
  }

  const PermissionSet = [
    { name: 'operator', type: 'address' },
    { name: 'permissions', type: 'uint8[]' },
  ];

  const PermissionPermit = [
    { name: 'permissions', type: 'PermissionSet[]' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ];

  async function getSignature(
    sourceHub: DCAHub,
    signer: SignerWithAddress,
    tokenId: BigNumber,
    permissions: { operator: string; permissions: Permission[] }[]
  ) {
    const verifyingContract = await sourceHub.permissionManager();
    const { domain, types, value } = buildPermitData(sourceHub.address, verifyingContract, tokenId, permissions);
    const signature = await signer._signTypedData(domain, types, value);
    return fromRpcSig(signature);
  }

  function buildPermitData(
    hub: string,
    verifyingContract: string,
    tokenId: BigNumber,
    permissions: { operator: string; permissions: Permission[] }[]
  ) {
    return {
      primaryType: 'PermissionPermit',
      types: { PermissionSet, PermissionPermit },
      domain: { ...NAME_AND_VERSION[hub], chainId, verifyingContract },
      value: { tokenId, permissions, nonce: 0, deadline: constants.MAX_UINT_256 },
    };
  }

  enum Permission {
    INCREASE,
    REDUCE,
    WITHDRAW,
    TERMINATE,
  }
});
