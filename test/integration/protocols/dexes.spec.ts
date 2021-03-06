import { expect } from 'chai';
import { deployments, ethers, getNamedAccounts } from 'hardhat';
import { JsonRpcSigner, TransactionResponse } from '@ethersproject/providers';
import { constants, wallet } from '@test-utils';
import { given, then, when } from '@test-utils/bdd';
import evm, { snapshot } from '@test-utils/evm';
import { DCAHubCompanion, DCAHubSwapper, IERC20Metadata, IERC20Metadata__factory } from '@typechained';
import { DCAHub } from '@mean-finance/dca-v2-core/typechained';
import { abi as DCA_HUB_ABI } from '@mean-finance/dca-v2-core/artifacts/contracts/DCAHub/DCAHub.sol/DCAHub.json';
import { BigNumber, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { SwapInterval } from '@test-utils/interval-utils';
import zrx from '@test-utils/dexes/zrx';
import paraswap from '@test-utils/dexes/paraswap';
import oneinch from '@test-utils/dexes/oneinch';
import { DeterministicFactory, DeterministicFactory__factory } from '@mean-finance/deterministic-factory/typechained';

const WETH_ADDRESS_BY_NETWORK: { [network: string]: string } = {
  polygon: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
};
const WETH_WHALE_ADDRESS_BY_NETWORK: { [network: string]: string } = {
  polygon: '0xdc9232e2df177d7a12fdff6ecbab114e2231198d',
};

describe.skip('Dexes', () => {
  // Setup params
  let WETH: IERC20Metadata;
  let governor: JsonRpcSigner;
  let sender: SignerWithAddress, recipient: SignerWithAddress;
  let DCAHubSwapper: DCAHubSwapper;
  let DCAHubCompanion: DCAHubCompanion;
  let DCAHub: DCAHub;
  let initialPerformedSwaps: number;
  let snapshotId: string;

  // Deposit params
  const RATE = utils.parseEther('1');
  const AMOUNT_OF_SWAPS = 10;
  const depositAmount = RATE.mul(AMOUNT_OF_SWAPS);

  context('on Polygon', () => {
    before(async () => {
      snapshotId = await liquidityTestSetup({ network: 'polygon', swapFee: 25000 }); // 2.5%
    });
    testDex({
      dex: 'Paraswap',
      ticker: 'MAI',
      tokenAddress: '0xa3fa99a148fa48d14ed51d610c367c61876997f1',
      network: 'polygon',
      getQuoteData: async (tokenIn: IERC20Metadata, tokenOut: IERC20Metadata, amountToSell: BigNumber) => {
        return await paraswap.swap({
          network: '137',
          srcToken: tokenIn.address,
          srcDecimals: await tokenIn.decimals(),
          destToken: tokenOut.address,
          destDecimals: await tokenOut.decimals(),
          amount: amountToSell.toString(),
          side: 'SELL',
          txOrigin: sender.address,
          userAddress: DCAHubSwapper.address,
          receiver: DCAHubSwapper.address,
        });
      },
    });
  });

  async function liquidityTestSetup({ network, swapFee }: { network: string; swapFee?: number }): Promise<string> {
    await evm.reset({
      network,
      skipHardhatDeployFork: true,
    });
    [sender, recipient] = await ethers.getSigners();
    const namedAccounts = await getNamedAccounts();
    const governorAddress = namedAccounts.governor;
    governor = await wallet.impersonate(governorAddress);

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
    await wallet.setBalance({ account: governorAddress, balance: constants.MAX_UINT_256 });
    const timelockContract = await ethers.getContract('Timelock');
    const timelock = await wallet.impersonate(timelockContract.address);
    await wallet.setBalance({ account: timelock._address, balance: constants.MAX_UINT_256 });

    // Allow one minute interval
    await DCAHub.connect(governor).addSwapIntervalsToAllowedList([SwapInterval.ONE_MINUTE.seconds]);
    if (swapFee) await DCAHub.connect(timelock).setSwapFee(swapFee);

    WETH = await ethers.getContractAt<IERC20Metadata>(IERC20Metadata__factory.abi, WETH_ADDRESS_BY_NETWORK[network]);
    const wethWhale = await wallet.impersonate(WETH_WHALE_ADDRESS_BY_NETWORK[network]);
    await wallet.setBalance({ account: WETH_WHALE_ADDRESS_BY_NETWORK[network], balance: constants.MAX_UINT_256 });

    await WETH.connect(wethWhale).transfer(sender.address, depositAmount);
    await WETH.connect(sender).approve(DCAHub.address, depositAmount);

    return await snapshot.take();
  }

  type DexResponse = {
    to: string;
    allowanceTarget: string;
    data: string;
  };

  async function testDex({
    dex,
    ticker,
    tokenAddress,
    getQuoteData,
    network,
    slippage,
  }: {
    dex: string;
    ticker: string;
    tokenAddress: string;
    getQuoteData: (tokenIn: IERC20Metadata, tokenOut: IERC20Metadata, amountToSell: BigNumber) => Promise<DexResponse>;
    network: string;
    slippage?: number;
  }): Promise<void> {
    let initialHubWETHBalance: BigNumber;
    let initialHubTokenBalance: BigNumber;
    let reward: BigNumber;
    let toProvide: BigNumber;
    let token: IERC20Metadata;
    describe(`${dex} - WETH/${ticker}`, () => {
      const WETH_ADDRESS = WETH_ADDRESS_BY_NETWORK[network];
      given(async () => {
        await snapshot.revert(snapshotId);
        token = await ethers.getContractAt(IERC20Metadata__factory.abi, tokenAddress);
        await DCAHub.connect(sender)['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'](
          WETH.address,
          tokenAddress,
          depositAmount,
          AMOUNT_OF_SWAPS,
          SwapInterval.ONE_MINUTE.seconds,
          sender.address,
          []
        );
        const sortedTokens = tokenAddress < WETH_ADDRESS ? [tokenAddress, WETH_ADDRESS] : [WETH_ADDRESS, tokenAddress];
        const wethIndex = tokenAddress < WETH_ADDRESS ? 1 : 0;
        initialPerformedSwaps = await performedSwaps({ tokenAddress, wethAddress: WETH_ADDRESS });
        initialHubWETHBalance = await WETH.balanceOf(DCAHub.address);
        initialHubTokenBalance = await token.balanceOf(DCAHub.address);
        const { tokens } = await DCAHubCompanion.getNextSwapInfo([{ tokenA: sortedTokens[0], tokenB: sortedTokens[1] }]);
        const weth = tokens[wethIndex];
        const dexQuote = await getQuoteData(WETH, token, weth.reward);
        await DCAHubSwapper.connect(governor).defineDexSupport(dexQuote.to, true);
        const swapTx = await DCAHubSwapper.swapWithDex(
          dexQuote.to,
          dexQuote.allowanceTarget,
          [sortedTokens[0], sortedTokens[1]],
          [{ indexTokenA: 0, indexTokenB: 1 }],
          [dexQuote.data],
          false,
          recipient.address,
          constants.MAX_UINT_256
        );

        ({ reward, toProvide } = await getTransfers(swapTx));
      });
      then('swap is executed', async () => {
        expect(await performedSwaps({ tokenAddress, wethAddress: WETH_ADDRESS })).to.equal(initialPerformedSwaps + 1);
      });
      then('hub balance is correct', async () => {
        const hubWETHBalance = await WETH.balanceOf(DCAHub.address);
        const hubTokenBalance = await token.balanceOf(DCAHub.address);
        expect(hubWETHBalance, 'Hub WETH balance is incorrect').to.equal(initialHubWETHBalance.sub(reward));
        expect(hubTokenBalance, `Hub ${ticker} balance is incorrect`).to.equal(initialHubTokenBalance.add(toProvide));
      });
    });
  }

  async function performedSwaps({ tokenAddress, wethAddress }: { tokenAddress: string; wethAddress: string }): Promise<number> {
    const { performedSwaps } = await DCAHub.swapData(tokenAddress, wethAddress, SwapInterval.ONE_MINUTE.mask);
    return performedSwaps;
  }

  async function getTransfers(
    tx: TransactionResponse
  ): Promise<{ reward: BigNumber; toProvide: BigNumber; sentToAgg: BigNumber; receivedFromAgg: BigNumber }> {
    const swappedEvent = await getSwappedEvent(tx);
    const [tokenA, tokenB] = swappedEvent.args.swapInformation.tokens;
    const reward = tokenA.reward.gt(tokenB.reward) ? tokenA.reward : tokenB.reward;
    const toProvide = tokenA.toProvide.gt(tokenB.toProvide) ? tokenA.toProvide : tokenB.toProvide;

    const receivedFromAgg = await findTransferValue(tx, { notFrom: DCAHub, to: DCAHubSwapper });
    const sentToAgg = await findTransferValue(tx, { from: DCAHubSwapper, notTo: DCAHub });
    return { reward, toProvide, receivedFromAgg, sentToAgg };
  }

  function getSwappedEvent(tx: TransactionResponse): Promise<utils.LogDescription> {
    return findLogs(tx, new utils.Interface(DCA_HUB_ABI), 'Swapped');
  }

  async function findTransferValue(
    tx: TransactionResponse,
    {
      from,
      notFrom,
      to,
      notTo,
    }: { from?: { address: string }; notFrom?: { address: string }; to?: { address: string }; notTo?: { address: string } }
  ) {
    const log = await findLogs(
      tx,
      WETH.interface,
      'Transfer',
      (log) =>
        (!from || log.args.from === from.address) &&
        (!to || log.args.to === to.address) &&
        (!notFrom || log.args.from !== notFrom.address) &&
        (!notTo || log.args.to !== notTo.address)
    );
    return BigNumber.from(log.args.value);
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
