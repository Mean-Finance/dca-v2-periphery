import { expect } from 'chai';
import { deployments, ethers, getNamedAccounts } from 'hardhat';
import { TransactionResponse } from '@ethersproject/providers';
import { constants, wallet } from '@test-utils';
import { given, then, when } from '@test-utils/bdd';
import evm, { snapshot } from '@test-utils/evm';
import { DCAHubCompanion, IERC20 } from '@typechained';
import { DCAHub } from '@mean-finance/dca-v2-core/typechained';
import { abi as DCA_HUB_ABI } from '@mean-finance/dca-v2-core/artifacts/contracts/DCAHub/DCAHub.sol/DCAHub.json';
import { getNodeUrl } from '@utils/network';
import { abi as IERC20_ABI } from '@openzeppelin/contracts/build/contracts/IERC20.json';
import { BigNumber, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers';
import { SwapInterval } from '@test-utils/interval-utils';
import forkBlockNumber from '@integration/fork-block-numbers';
import { fromRpcSig } from 'ethereumjs-util';

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH_WHALE_ADDRESS = '0xf04a5cc80b1e94c69b48f5ee68a08cd2f09a7c3e';
const USDC_WHALE_ADDRESS = '0x0a59649758aa4d66e25f08dd01271e891fe52199';

describe.only('Multicall', () => {
  let WETH: IERC20, USDC: IERC20;
  let positionOwner: SignerWithAddress, swapper: SignerWithAddress, recipient: SignerWithAddress;
  let DCAHubCompanion: DCAHubCompanion;
  let DCAPermissionManager: string;
  let DCAHub: DCAHub;
  let initialHubWTokenBalance: BigNumber, initialRecipientProtocolBalance: BigNumber;
  let chainId: BigNumber;
  let snapshotId: string;

  const RATE = BigNumber.from(100000000);
  const AMOUNT_OF_SWAPS = 10;

  before(async () => {
    await evm.reset({
      jsonRpcUrl: getNodeUrl('mainnet'),
      blockNumber: forkBlockNumber['wtoken'],
    });
    [positionOwner, swapper, recipient] = await ethers.getSigners();

    await deployments.fixture('DCAHubCompanion', { keepExistingDeployments: false });
    DCAHub = await ethers.getContract('DCAHub');
    DCAHubCompanion = await ethers.getContract('DCAHubCompanion');
    DCAPermissionManager = await DCAHub.permissionManager();

    const namedAccounts = await getNamedAccounts();
    const governorAddress = namedAccounts.governor;
    const governor = await wallet.impersonate(governorAddress);
    await ethers.provider.send('hardhat_setBalance', [governorAddress, '0xffffffffffffffff']);

    // Allow one minute interval
    await DCAHub.connect(governor).addSwapIntervalsToAllowedList([SwapInterval.ONE_MINUTE.seconds]);

    WETH = await ethers.getContractAt(IERC20_ABI, WETH_ADDRESS);
    USDC = await ethers.getContractAt(IERC20_ABI, USDC_ADDRESS);

    // Send tokens from whales, to our users
    await distributeTokensToUsers();

    initialHubWTokenBalance = await WETH.balanceOf(DCAHub.address);
    initialRecipientProtocolBalance = await ethers.provider.getBalance(recipient.address);
    chainId = BigNumber.from((await ethers.provider.getNetwork()).chainId);
    snapshotId = await snapshot.take();
  });

  beforeEach(async () => {
    await snapshot.revert(snapshotId);
  });

  describe('protocol token as "from"', () => {
    when('reducing a position with protocol token', () => {
      const AMOUNT_TO_REDUCE = RATE.mul(AMOUNT_OF_SWAPS).div(2);
      let positionId: BigNumber;
      let hubWTokenBalanceAfterDeposit: BigNumber;
      given(async () => {
        positionId = await depositWithWTokenAsFrom();
        hubWTokenBalanceAfterDeposit = await WETH.balanceOf(DCAHub.address);

        const permissionData = await addPermissionToCompanionData(positionId, Permission.REDUCE);
        const { data: reduceData } = await DCAHubCompanion.populateTransaction.reducePositionUsingProtocolToken(
          positionId,
          AMOUNT_TO_REDUCE,
          AMOUNT_OF_SWAPS,
          recipient.address
        );
        await DCAHubCompanion.multicall([permissionData, reduceData!]);
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
        positionId = await depositWithWTokenAsFrom();
        hubWTokenBalanceAfterDeposit = await WETH.balanceOf(DCAHub.address);
        const permissionData = await addPermissionToCompanionData(positionId, Permission.TERMINATE);
        const { data: terminateData } = await DCAHubCompanion.populateTransaction.terminateUsingProtocolTokenAsFrom(
          positionId,
          recipient.address,
          recipient.address
        );
        await DCAHubCompanion.multicall([permissionData, terminateData!]);
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

    async function depositWithWTokenAsFrom() {
      await WETH.connect(positionOwner).approve(DCAHub.address, RATE.mul(AMOUNT_OF_SWAPS));
      const tx = await DCAHub.connect(positionOwner).deposit(
        WETH.address,
        USDC.address,
        RATE.mul(AMOUNT_OF_SWAPS),
        AMOUNT_OF_SWAPS,
        SwapInterval.ONE_MINUTE.seconds,
        positionOwner.address,
        []
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
        const permissionData = await addPermissionToCompanionData(positionId, Permission.WITHDRAW);
        const { data: withdrawData } = await DCAHubCompanion.populateTransaction.withdrawSwappedUsingProtocolToken(
          positionId,
          recipient.address
        );
        await DCAHubCompanion.multicall([permissionData, withdrawData!]);
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
        const permissionData = await addPermissionToCompanionData(positionId, Permission.WITHDRAW);
        const { data: withdrawData } = await DCAHubCompanion.populateTransaction.withdrawSwappedManyUsingProtocolToken(
          [positionId],
          recipient.address
        );
        await DCAHubCompanion.multicall([permissionData, withdrawData!]);
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
        const permissionData = await addPermissionToCompanionData(positionId, Permission.TERMINATE);
        const { data: terminateData } = await DCAHubCompanion.populateTransaction.terminateUsingProtocolTokenAsTo(
          positionId,
          recipient.address,
          recipient.address
        );
        await DCAHubCompanion.multicall([permissionData, terminateData!]);
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
  });

  when('trying to withdraw swapped and unswapped balance in one tx', () => {
    let positionId: BigNumber;
    let swappedBalance: BigNumber, unswappedBalance: BigNumber;
    let hubFromTokenBalanceAfterSwap: BigNumber, hubToTokenBalanceAfterSwap: BigNumber;
    given(async () => {
      ({ positionId, swappedBalance, unswappedBalance } = await depositWithWTokenAsToAndSwap());
      hubFromTokenBalanceAfterSwap = await USDC.balanceOf(DCAHub.address);
      hubToTokenBalanceAfterSwap = await WETH.balanceOf(DCAHub.address);
      const permissionData = await addPermissionToCompanionData(positionId, Permission.REDUCE, Permission.WITHDRAW);
      const { data: reduceData } = await DCAHubCompanion.populateTransaction.reducePositionProxy(
        positionId,
        unswappedBalance,
        0,
        recipient.address
      );
      const { data: withdrawData } = await DCAHubCompanion.populateTransaction.withdrawSwappedProxy(positionId, recipient.address);
      await DCAHubCompanion.multicall([permissionData, reduceData!, withdrawData!]);
    });
    then(`hub's FROM balance is reduced`, async () => {
      const balance = await USDC.balanceOf(DCAHub.address);
      expect(balance).to.equal(hubFromTokenBalanceAfterSwap.sub(unswappedBalance));
    });
    then(`hub's TO balance is reduced`, async () => {
      const balance = await WETH.balanceOf(DCAHub.address);
      expect(balance).to.equal(hubToTokenBalanceAfterSwap.sub(swappedBalance));
    });
    then(`recipients's FROM increases`, async () => {
      const balance = await USDC.balanceOf(recipient.address);
      expect(balance).to.equal(unswappedBalance);
    });
    then(`recipients's TO increases`, async () => {
      const balance = await WETH.balanceOf(recipient.address);
      expect(balance).to.equal(swappedBalance);
    });
    thenCompanionRemainsWithoutAnyBalance();
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
    await WETH.connect(wethWhale).transfer(swapper.address, BigNumber.from(10).pow(23));
    await WETH.connect(wethWhale).transfer(positionOwner.address, BigNumber.from(10).pow(23));
    await USDC.connect(usdcWhale).transfer(positionOwner.address, BigNumber.from(10).pow(12));
    await USDC.connect(usdcWhale).transfer(swapper.address, BigNumber.from(10).pow(12));
  }

  async function depositWithWTokenAsToAndSwap() {
    await USDC.connect(positionOwner).approve(DCAHub.address, constants.MAX_UINT_256);
    const tx = await DCAHub.connect(positionOwner).deposit(
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

    await WETH.connect(swapper).approve(DCAHubCompanion.address, constants.MAX_UINT_256);
    await DCAHubCompanion.connect(swapper).swapForCaller(
      [USDC_ADDRESS, WETH_ADDRESS],
      [{ indexTokenA: 0, indexTokenB: 1 }],
      [0, 0],
      [constants.MAX_UINT_256, constants.MAX_UINT_256],
      swapper.address,
      constants.MAX_UINT_256
    );

    const { swapped } = await DCAHub.userPosition(positionId);
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

  async function addPermissionToCompanionData(tokenId: BigNumber, ...permissions: Permission[]) {
    const permissionsStruct = [{ operator: DCAHubCompanion.address, permissions }];
    const { v, r, s } = await getSignature(tokenId, permissionsStruct);
    const { data } = await DCAHubCompanion.populateTransaction.permissionPermitProxy(
      permissionsStruct,
      tokenId,
      constants.MAX_UINT_256,
      v,
      r,
      s
    );
    return data!;
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

  async function getSignature(tokenId: BigNumber, permissions: { operator: string; permissions: Permission[] }[]) {
    const { domain, types, value } = buildPermitData(tokenId, permissions);
    const signature = await positionOwner._signTypedData(domain, types, value);
    return fromRpcSig(signature);
  }

  function buildPermitData(tokenId: BigNumber, permissions: { operator: string; permissions: Permission[] }[]) {
    return {
      primaryType: 'PermissionPermit',
      types: { PermissionSet, PermissionPermit },
      domain: { name: 'Mean Finance DCA', version: '1', chainId, verifyingContract: DCAPermissionManager },
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
