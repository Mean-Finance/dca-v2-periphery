import { expect } from 'chai';
import { deployments, ethers, getNamedAccounts } from 'hardhat';
import { TransactionResponse } from '@ethersproject/providers';
import { constants, wallet } from '@test-utils';
import { contract, given, then, when } from '@test-utils/bdd';
import evm, { snapshot } from '@test-utils/evm';
import { DCAHubCompanion, DCAHubSwapper, IERC20 } from '@typechained';
import { DCAHub, DCAPermissionsManager, OracleAggregator } from '@mean-finance/dca-v2-core/typechained';
import { abi as DCA_HUB_ABI } from '@mean-finance/dca-v2-core/artifacts/contracts/DCAHub/DCAHub.sol/DCAHub.json';
import { abi as IERC20_ABI } from '@openzeppelin/contracts/build/contracts/IERC20.json';
import { BigNumber, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { SwapInterval } from '@test-utils/interval-utils';
import forkBlockNumber from '@integration/fork-block-numbers';
import { DeterministicFactory, DeterministicFactory__factory } from '@mean-finance/deterministic-factory/typechained';

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH_WHALE_ADDRESS = '0xf04a5cc80b1e94c69b48f5ee68a08cd2f09a7c3e';
const USDC_WHALE_ADDRESS = '0xcffad3200574698b78f32232aa9d63eabd290703';

contract('WToken', () => {
  let WETH: IERC20, USDC: IERC20;
  let cindy: SignerWithAddress, swapper: SignerWithAddress, recipient: SignerWithAddress;
  let DCAHubCompanion: DCAHubCompanion;
  let DCAHubSwapper: DCAHubSwapper;
  let DCAHub: DCAHub, DCAPermissionManager: DCAPermissionsManager;
  let initialHubWTokenBalance: BigNumber, initialRecipientProtocolBalance: BigNumber;
  let snapshotId: string;

  const RATE = BigNumber.from(100000000);
  const AMOUNT_OF_SWAPS = 10;
  const PROTOCOL_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

  before(async () => {
    await evm.reset({
      network: 'mainnet',
      blockNumber: forkBlockNumber['wtoken'],
      skipHardhatDeployFork: true,
    });
    [cindy, swapper, recipient] = await ethers.getSigners();

    const namedAccounts = await getNamedAccounts();
    const governorAddress = namedAccounts.governor;
    const governor = await wallet.impersonate(governorAddress);
    await ethers.provider.send('hardhat_setBalance', [governorAddress, '0xffffffffffffffff']);

    const deterministicFactory = await ethers.getContractAt<DeterministicFactory>(
      DeterministicFactory__factory.abi,
      '0xbb681d77506df5CA21D2214ab3923b4C056aa3e2'
    );

    await deterministicFactory.connect(governor).grantRole(await deterministicFactory.DEPLOYER_ROLE(), namedAccounts.deployer);

    await deployments.run(['DCAHub', 'DCAHubCompanion', 'DCAHubSwapper'], {
      resetMemory: true,
      deletePreviousDeployments: false,
      writeDeploymentsToFiles: false,
    });

    DCAHub = await ethers.getContract('DCAHub');
    DCAHubCompanion = await ethers.getContract('DCAHubCompanion');
    DCAHubSwapper = await ethers.getContract('DCAHubSwapper');
    DCAPermissionManager = await ethers.getContract('PermissionsManager');

    // Allow tokens
    await DCAHub.connect(governor).setAllowedTokens([WETH_ADDRESS, USDC_ADDRESS], [true, true]);

    // Allow one minute interval
    await DCAHub.connect(governor).addSwapIntervalsToAllowedList([SwapInterval.ONE_MINUTE.seconds]);

    // Set Uniswap oracle so we don't have issues while moving timestamp (Chainlink has maxDelay = 1 day)
    const oracleAggregator = await ethers.getContract<OracleAggregator>('OracleAggregator');
    await oracleAggregator.connect(governor).setOracleForPair(WETH_ADDRESS, USDC_ADDRESS, 2);

    WETH = await ethers.getContractAt(IERC20_ABI, WETH_ADDRESS);
    USDC = await ethers.getContractAt(IERC20_ABI, USDC_ADDRESS);

    // Send tokens from whales, to our users
    await distributeTokensToUsers();

    initialHubWTokenBalance = await WETH.balanceOf(DCAHub.address);
    initialRecipientProtocolBalance = await ethers.provider.getBalance(recipient.address);
    snapshotId = await snapshot.take();
  });

  beforeEach('Deploy and configure', async () => {
    await snapshot.revert(snapshotId);
  });

  describe('protocol token as "from"', () => {
    when('making a deposit', () => {
      let positionId: BigNumber;
      given(async () => {
        positionId = await depositWithProtocolTokenAsFrom();
      });
      then('position is created with wToken', async () => {
        const userPosition = await DCAHub.userPosition(positionId);
        expect(userPosition.from).to.equal(WETH_ADDRESS);
        expect(userPosition.rate).to.equal(RATE);
        expect(userPosition.swapsLeft).to.equal(AMOUNT_OF_SWAPS);
      });
      then(`hub's wToken balance increases`, async () => {
        const balance = await WETH.balanceOf(DCAHub.address);
        expect(balance).to.equal(initialHubWTokenBalance.add(RATE.mul(AMOUNT_OF_SWAPS)));
      });
      thenCompanionRemainsWithoutAnyBalance();
    });

    when('making a deposit, but sending less protocol token than expected', () => {
      const AMOUNT = RATE.mul(AMOUNT_OF_SWAPS);
      let tx: Promise<TransactionResponse>;
      given(async () => {
        tx = DCAHubCompanion.connect(cindy).depositUsingProtocolToken(
          PROTOCOL_TOKEN,
          USDC.address,
          RATE.mul(AMOUNT_OF_SWAPS),
          AMOUNT_OF_SWAPS,
          SwapInterval.ONE_MINUTE.seconds,
          cindy.address,
          [],
          ethers.utils.randomBytes(0),
          { value: AMOUNT.sub(1) }
        );
      });
      then('tx reverts', async () => {
        await expect(tx).to.have.reverted;
      });
    });

    when('increasing a position with protocol token', () => {
      const AMOUNT_TO_INCREASE = RATE.mul(AMOUNT_OF_SWAPS);
      let positionId: BigNumber;
      let hubWTokenBalanceAfterDeposit: BigNumber;
      given(async () => {
        positionId = await depositWithProtocolTokenAsFrom();
        hubWTokenBalanceAfterDeposit = await WETH.balanceOf(DCAHub.address);
        await DCAHubCompanion.increasePositionUsingProtocolToken(positionId, AMOUNT_TO_INCREASE, AMOUNT_OF_SWAPS, { value: AMOUNT_TO_INCREASE });
      });
      then('position is increased', async () => {
        const userPosition = await DCAHub.userPosition(positionId);
        expect(userPosition.from).to.equal(WETH_ADDRESS);
        expect(userPosition.rate).to.equal(RATE.mul(2));
        expect(userPosition.swapsLeft).to.equal(AMOUNT_OF_SWAPS);
      });
      then(`hub's wToken balance increases`, async () => {
        const balance = await WETH.balanceOf(DCAHub.address);
        expect(balance).to.equal(hubWTokenBalanceAfterDeposit.add(AMOUNT_TO_INCREASE));
      });
      thenCompanionRemainsWithoutAnyBalance();
    });

    when('increasing a position with protocol token, but we sent less than expected', () => {
      const AMOUNT_TO_INCREASE = RATE.mul(AMOUNT_OF_SWAPS);
      let tx: Promise<TransactionResponse>;
      given(async () => {
        const positionId = await depositWithProtocolTokenAsFrom();
        tx = DCAHubCompanion.increasePositionUsingProtocolToken(positionId, AMOUNT_TO_INCREASE, AMOUNT_OF_SWAPS, {
          value: AMOUNT_TO_INCREASE.sub(1),
        });
      });
      then('tx reverts', async () => {
        await expect(tx).to.have.reverted;
      });
    });

    when('reducing a position with protocol token', () => {
      const AMOUNT_TO_REDUCE = RATE.mul(AMOUNT_OF_SWAPS).div(2);
      let positionId: BigNumber;
      let hubWTokenBalanceAfterDeposit: BigNumber;
      given(async () => {
        positionId = await depositWithProtocolTokenAsFrom();
        hubWTokenBalanceAfterDeposit = await WETH.balanceOf(DCAHub.address);
        await DCAHubCompanion.reducePositionUsingProtocolToken(positionId, AMOUNT_TO_REDUCE, AMOUNT_OF_SWAPS, recipient.address);
      });
      then('position is reduced', async () => {
        const userPosition = await DCAHub.userPosition(positionId);
        expect(userPosition.from).to.equal(WETH_ADDRESS);
        expect(userPosition.rate).to.equal(RATE.div(2));
        expect(userPosition.swapsLeft).to.equal(AMOUNT_OF_SWAPS);
      });
      then(`hub's wToken balance is reduced`, async () => {
        const balance = await WETH.balanceOf(DCAHub.address);
        expect(balance).to.equal(hubWTokenBalanceAfterDeposit.sub(AMOUNT_TO_REDUCE));
      });
      then(`recipients's protocol balance increases`, async () => {
        const balance = await ethers.provider.getBalance(recipient.address);
        expect(balance).to.equal(initialRecipientProtocolBalance.add(AMOUNT_TO_REDUCE));
      });
      thenCompanionRemainsWithoutAnyBalance();
    });

    when(`terminating a position with protocol token as 'from'`, () => {
      const AMOUNT_RETURNED = RATE.mul(AMOUNT_OF_SWAPS);
      let positionId: BigNumber;
      let hubWTokenBalanceAfterDeposit: BigNumber;
      given(async () => {
        positionId = await depositWithProtocolTokenAsFrom();
        hubWTokenBalanceAfterDeposit = await WETH.balanceOf(DCAHub.address);
        await DCAHubCompanion.terminateUsingProtocolTokenAsFrom(positionId, recipient.address, recipient.address);
      });
      then('position is terminated', async () => {
        const userPosition = await DCAHub.userPosition(positionId);
        expect(userPosition.swapInterval).to.equal(0);
      });
      then(`hub's wToken balance is reduced`, async () => {
        const balance = await WETH.balanceOf(DCAHub.address);
        expect(balance).to.equal(hubWTokenBalanceAfterDeposit.sub(AMOUNT_RETURNED));
      });
      then(`recipients's protocol balance increases`, async () => {
        const balance = await ethers.provider.getBalance(recipient.address);
        expect(balance).to.equal(initialRecipientProtocolBalance.add(AMOUNT_RETURNED));
      });
      thenCompanionRemainsWithoutAnyBalance();
    });

    async function depositWithProtocolTokenAsFrom() {
      const tx = await DCAHubCompanion.connect(cindy).depositUsingProtocolToken(
        PROTOCOL_TOKEN,
        USDC.address,
        RATE.mul(AMOUNT_OF_SWAPS),
        AMOUNT_OF_SWAPS,
        SwapInterval.ONE_MINUTE.seconds,
        cindy.address,
        [{ operator: DCAHubCompanion.address, permissions: [0, 1, 2, 3] }],
        ethers.utils.randomBytes(0),
        { value: RATE.mul(AMOUNT_OF_SWAPS) }
      );
      const event = await getHubEvent(tx, 'Deposited');
      return event.args.positionId;
    }
  });

  describe('protocol token as "to"', () => {
    when('withdrawing from a position', () => {
      let positionId: BigNumber;
      let swappedBalance: BigNumber;
      let hubWTokenBalanceAfterSwap: BigNumber;
      given(async () => {
        ({ positionId, swappedBalance } = await depositWithWTokenAsToAndSwap());
        hubWTokenBalanceAfterSwap = await WETH.balanceOf(DCAHub.address);
        await DCAHubCompanion.withdrawSwappedUsingProtocolToken(positionId, recipient.address);
      });
      then('position has no more swapped balance', async () => {
        const userPosition = await DCAHub.userPosition(positionId);
        expect(userPosition.swapped).to.equal(0);
      });
      then(`hub's wToken balance is reduced`, async () => {
        const balance = await WETH.balanceOf(DCAHub.address);
        expect(balance).to.equal(hubWTokenBalanceAfterSwap.sub(swappedBalance));
      });
      then(`recipients's protocol balance increases`, async () => {
        const balance = await ethers.provider.getBalance(recipient.address);
        expect(balance).to.equal(initialRecipientProtocolBalance.add(swappedBalance));
      });
      thenCompanionRemainsWithoutAnyBalance();
    });

    when('withdrawing many from a position', () => {
      let positionId: BigNumber;
      let swappedBalance: BigNumber;
      let hubWTokenBalanceAfterSwap: BigNumber;
      given(async () => {
        ({ positionId, swappedBalance } = await depositWithWTokenAsToAndSwap());
        hubWTokenBalanceAfterSwap = await WETH.balanceOf(DCAHub.address);
        await DCAHubCompanion.withdrawSwappedManyUsingProtocolToken([positionId], recipient.address);
      });
      then('position has no more swapped balance', async () => {
        const userPosition = await DCAHub.userPosition(positionId);
        expect(userPosition.swapped).to.equal(0);
      });
      then(`hub's wToken balance is reduced`, async () => {
        const balance = await WETH.balanceOf(DCAHub.address);
        expect(balance).to.equal(hubWTokenBalanceAfterSwap.sub(swappedBalance));
      });
      then(`recipients's protocol balance increases`, async () => {
        const balance = await ethers.provider.getBalance(recipient.address);
        expect(balance).to.equal(initialRecipientProtocolBalance.add(swappedBalance));
      });
      thenCompanionRemainsWithoutAnyBalance();
    });

    when(`terminating a position with protocol token as 'to'`, () => {
      let positionId: BigNumber;
      let swappedBalance: BigNumber;
      let hubWTokenBalanceAfterSwap: BigNumber;
      given(async () => {
        ({ positionId, swappedBalance } = await depositWithWTokenAsToAndSwap());
        hubWTokenBalanceAfterSwap = await WETH.balanceOf(DCAHub.address);
        await DCAHubCompanion.terminateUsingProtocolTokenAsTo(positionId, recipient.address, recipient.address);
      });
      then('position is terminated', async () => {
        const userPosition = await DCAHub.userPosition(positionId);
        expect(userPosition.swapInterval).to.equal(0);
      });
      then(`hub's wToken balance is reduced`, async () => {
        const balance = await WETH.balanceOf(DCAHub.address);
        expect(balance).to.equal(hubWTokenBalanceAfterSwap.sub(swappedBalance));
      });
      then(`recipients's protocol balance increases`, async () => {
        const balance = await ethers.provider.getBalance(recipient.address);
        expect(balance).to.equal(initialRecipientProtocolBalance.add(swappedBalance));
      });
      thenCompanionRemainsWithoutAnyBalance();
    });

    async function depositWithWTokenAsToAndSwap() {
      await USDC.connect(cindy).approve(DCAHub.address, constants.MAX_UINT_256);
      const tx = await DCAHub.connect(cindy)['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'](
        USDC.address,
        WETH.address,
        RATE.mul(AMOUNT_OF_SWAPS),
        AMOUNT_OF_SWAPS,
        SwapInterval.ONE_MINUTE.seconds,
        cindy.address,
        []
      );
      const event = await getHubEvent(tx, 'Deposited');
      const positionId = event.args.positionId;

      await DCAPermissionManager.connect(cindy).modify(positionId, [{ operator: DCAHubCompanion.address, permissions: [0, 1, 2, 3] }]);

      await WETH.connect(swapper).approve(DCAHubSwapper.address, constants.MAX_UINT_256);
      await DCAHubSwapper.connect(swapper).swapForCaller(
        [USDC_ADDRESS, WETH_ADDRESS],
        [{ indexTokenA: 0, indexTokenB: 1 }],
        [0, 0],
        [constants.MAX_UINT_256, constants.MAX_UINT_256],
        swapper.address,
        constants.MAX_UINT_256
      );

      const { swapped } = await DCAHub.userPosition(positionId);
      return { positionId, swappedBalance: swapped };
    }
  });

  function thenCompanionRemainsWithoutAnyBalance() {
    then('companion continues without wToken balance', async () => {
      const balance = await WETH.balanceOf(DCAHubCompanion.address);
      expect(balance).to.equal(0);
    });
    then('companion continues without platform balance', async () => {
      const balance = await ethers.provider.getBalance(DCAHubCompanion.address);
      expect(balance).to.equal(0);
    });
  }

  async function distributeTokensToUsers() {
    const wethWhale = await wallet.impersonate(WETH_WHALE_ADDRESS);
    const usdcWhale = await wallet.impersonate(USDC_WHALE_ADDRESS);
    await ethers.provider.send('hardhat_setBalance', [WETH_WHALE_ADDRESS, '0xffffffffffffffff']);
    await ethers.provider.send('hardhat_setBalance', [USDC_WHALE_ADDRESS, '0xffffffffffffffff']);
    await WETH.connect(wethWhale).transfer(swapper.address, BigNumber.from(10).pow(20));
    await USDC.connect(usdcWhale).transfer(cindy.address, BigNumber.from(10).pow(12));
    await USDC.connect(usdcWhale).transfer(swapper.address, BigNumber.from(10).pow(12));
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
});
