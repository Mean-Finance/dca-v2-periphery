import chai, { expect } from 'chai';
import { ethers } from 'hardhat';
import { contract, given, then, when } from '@test-utils/bdd';
import { snapshot } from '@test-utils/evm';
import {
  DCAFeeManagerMock,
  DCAFeeManagerMock__factory,
  IDCAHub,
  IDCAHubPositionHandler,
  IERC20,
  WrappedPlatformTokenMock,
  WrappedPlatformTokenMock__factory,
} from '@typechained';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { duration } from 'moment';
import { behaviours, wallet } from '@test-utils';
import { readArgFromEventOrFail } from '@test-utils/event-utils';
import { TransactionResponse } from '@ethersproject/providers';
import { IDCAFeeManager } from '@typechained/DCAFeeManager';
import { FakeContract, smock } from '@defi-wonderland/smock';
import { BigNumber, BigNumberish, constants, utils } from 'ethers';

chai.use(smock.matchers);

contract('DCAFeeManager', () => {
  const TOKEN_A = '0x0000000000000000000000000000000000000010';
  const TOKEN_B = '0x0000000000000000000000000000000000000011';
  const MAX_SHARES = 10000;
  const SWAP_INTERVAL = duration(1, 'day').asSeconds();
  let wToken: WrappedPlatformTokenMock;
  let DCAHub: FakeContract<IDCAHub>;
  let DCAFeeManager: DCAFeeManagerMock;
  let DCAFeeManagerFactory: DCAFeeManagerMock__factory;
  let erc20Token: FakeContract<IERC20>;
  let random: SignerWithAddress, governor: SignerWithAddress;
  let snapshotId: string;

  before('Setup accounts and contracts', async () => {
    [random, governor] = await ethers.getSigners();
    const wTokenFactory: WrappedPlatformTokenMock__factory = await ethers.getContractFactory(
      'contracts/mocks/WrappedPlatformTokenMock.sol:WrappedPlatformTokenMock'
    );
    DCAHub = await smock.fake('IDCAHub');
    erc20Token = await smock.fake('IERC20');
    wToken = await wTokenFactory.deploy('WETH', 'WETH', 18);
    await setProtocolBalance(wToken, utils.parseEther('100'));
    DCAFeeManagerFactory = await ethers.getContractFactory('contracts/mocks/DCAFeeManager/DCAFeeManager.sol:DCAFeeManagerMock');
    DCAFeeManager = await DCAFeeManagerFactory.deploy(DCAHub.address, wToken.address, governor.address);
    snapshotId = await snapshot.take();
  });

  beforeEach(async () => {
    await snapshot.revert(snapshotId);
    DCAHub.platformBalance.reset();
    DCAHub.withdrawFromPlatformBalance.reset();
    DCAHub.withdrawSwappedMany.reset();
    DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].reset();
    DCAHub.increasePosition.reset();
    DCAHub.terminate.reset();
    erc20Token.allowance.reset();
    erc20Token.approve.reset();
    erc20Token.transfer.reset();
  });

  describe('constructor', () => {
    when('contract is initiated', () => {
      then('hub is set correctly', async () => {
        expect(await DCAFeeManager.hub()).to.equal(DCAHub.address);
      });
      then('max token total share is set correctly', async () => {
        expect(await DCAFeeManager.MAX_TOKEN_TOTAL_SHARE()).to.equal(MAX_SHARES);
      });
      then('swap interval is set to daily', async () => {
        expect(await DCAFeeManager.SWAP_INTERVAL()).to.equal(SWAP_INTERVAL);
      });
      then('wToken is set correctly', async () => {
        expect(await DCAFeeManager.wToken()).to.equal(wToken.address);
      });
    });
  });

  describe('unwrapWToken', () => {
    const TOTAL_BALANCE = utils.parseEther('1');
    const BALANCE_TO_UNWRAP = utils.parseEther('0.1');
    when('unwrap is called', () => {
      given(async () => {
        await wToken.mint(DCAFeeManager.address, TOTAL_BALANCE);
        await DCAFeeManager.connect(governor).unwrapWToken(BALANCE_TO_UNWRAP);
      });
      then('given balance is unwrapped', async () => {
        expect(await wToken.balanceOf(DCAFeeManager.address)).to.equal(TOTAL_BALANCE.sub(BALANCE_TO_UNWRAP));
        expect(await getProtocolBalance(DCAFeeManager.address)).to.equal(BALANCE_TO_UNWRAP);
      });
    });
    shouldOnlyBeExecutableByGovernorOrAllowed({
      funcAndSignature: 'unwrapWToken',
      params: [BALANCE_TO_UNWRAP],
    });
  });

  describe('withdrawFromPlatformBalance', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    when('withdraw is executed', () => {
      const AMOUNT_TO_WITHDRAW = [{ token: TOKEN_A, amount: utils.parseEther('1') }];
      given(async () => {
        await DCAFeeManager.connect(governor).withdrawFromPlatformBalance(DCAHub.address, AMOUNT_TO_WITHDRAW, RECIPIENT);
      });
      then('hub is called correctly', () => {
        expect(DCAHub.withdrawFromPlatformBalance).to.have.been.calledOnce;
        const [amountToWithdraw, recipient] = DCAHub.withdrawFromPlatformBalance.getCall(0).args as [AmountToWithdraw[], string];
        expectAmounToWithdrawToBe(amountToWithdraw, AMOUNT_TO_WITHDRAW);
        expect(recipient).to.equal(RECIPIENT);
      });
    });
    shouldOnlyBeExecutableByGovernorOrAllowed({
      funcAndSignature: 'withdrawFromPlatformBalance',
      params: () => [DCAHub.address, [], RECIPIENT],
    });
  });

  describe('withdrawFromBalance', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    when('withdraw is executed', () => {
      const AMOUNT_TO_WITHDRAW = utils.parseEther('1');
      given(async () => {
        erc20Token.transfer.returns(true);
        await DCAFeeManager.connect(governor).withdrawFromBalance([{ token: erc20Token.address, amount: AMOUNT_TO_WITHDRAW }], RECIPIENT);
      });
      then('token is called correctly', () => {
        expect(erc20Token.transfer).to.have.been.calledOnceWith(RECIPIENT, AMOUNT_TO_WITHDRAW);
      });
    });
    shouldOnlyBeExecutableByGovernorOrAllowed({
      funcAndSignature: 'withdrawFromBalance',
      params: [[], RECIPIENT],
    });
  });

  describe('withdrawFromPositions', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    when('withdraw is executed', () => {
      const POSITION_SETS = [{ token: TOKEN_A, positionIds: [1, 2, 3] }];
      given(async () => {
        await DCAFeeManager.connect(governor).withdrawFromPositions(POSITION_SETS, RECIPIENT);
      });
      then('hub is called correctly', () => {
        expect(DCAHub.withdrawSwappedMany).to.have.been.calledOnce;
        const [positionSets, recipient] = DCAHub.withdrawSwappedMany.getCall(0).args as [PositionSet[], string];
        expectPositionSetsToBe(positionSets, POSITION_SETS);
        expect(recipient).to.equal(RECIPIENT);
      });
    });
    shouldOnlyBeExecutableByGovernorOrAllowed({
      funcAndSignature: 'withdrawFromPositions',
      params: [[], RECIPIENT],
    });
  });

  describe('withdrawProtocolToken', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    const TOTAL_BALANCE = utils.parseEther('1');
    const BALANCE_TO_WITHDRAW = utils.parseEther('0.1');
    when('unwrap is called', () => {
      given(async () => {
        await wToken.mint(DCAFeeManager.address, TOTAL_BALANCE);
        await DCAFeeManager.connect(governor).unwrapWToken(TOTAL_BALANCE);
        await DCAFeeManager.connect(governor).withdrawProtocolToken(BALANCE_TO_WITHDRAW, RECIPIENT);
      });
      then('amount to withdraw is sent to recipient', async () => {
        expect(await getProtocolBalance(RECIPIENT)).to.equal(BALANCE_TO_WITHDRAW);
      });
      then('leftover is still on the fee manager', async () => {
        expect(await getProtocolBalance(DCAFeeManager.address)).to.equal(TOTAL_BALANCE.sub(BALANCE_TO_WITHDRAW));
      });
    });
    shouldOnlyBeExecutableByGovernorOrAllowed({
      funcAndSignature: 'withdrawProtocolToken',
      params: [BALANCE_TO_WITHDRAW, RECIPIENT],
    });
  });

  describe('fillPositions', () => {
    const AMOUNT_OF_SWAPS = 10;
    const FULL_AMOUNT = utils.parseEther('1');
    const DISTRIBUTION = [
      { token: TOKEN_A, shares: MAX_SHARES / 2 },
      { token: TOKEN_B, shares: MAX_SHARES / 2 },
    ];
    const POSITION_ID_TOKEN_A = 1;
    const POSITION_ID_TOKEN_B = 2;
    when('allowance is zero', () => {
      given(async () => {
        erc20Token.allowance.returns(0);
        await DCAFeeManager.connect(governor).fillPositions(
          [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
          DISTRIBUTION
        );
      });
      then('full allowance is set', () => {
        expect(erc20Token.approve).to.have.been.calledOnceWith(DCAHub.address, constants.MaxUint256);
      });
    });
    when('there is no position created', () => {
      describe('and deposit fails', () => {
        given(async () => {
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].revertsAtCall(0);
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].returnsAtCall(1, POSITION_ID_TOKEN_B);
          await DCAFeeManager.connect(governor).fillPositions(
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('full amount is spent on last target token', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledTwice;
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledWith(
            erc20Token.address,
            TOKEN_B,
            FULL_AMOUNT,
            AMOUNT_OF_SWAPS,
            SWAP_INTERVAL,
            DCAFeeManager.address,
            []
          );
        });
        then('position is stored for the pair', async () => {
          const key = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_B);
          expect(await DCAFeeManager.positions(key)).to.equal(POSITION_ID_TOKEN_B);
        });
        then('position is stored for the to token', async () => {
          const positions = await DCAFeeManager.positionsWithToken(TOKEN_B);
          expect(positions).to.eql([BigNumber.from(POSITION_ID_TOKEN_B)]);
        });
      });
      describe('and deposit works', () => {
        given(async () => {
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].returnsAtCall(0, POSITION_ID_TOKEN_A);
          DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'].returnsAtCall(1, POSITION_ID_TOKEN_B);
          await DCAFeeManager.connect(governor).fillPositions(
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('deposit with token A is made correctly', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledWith(
            erc20Token.address,
            TOKEN_A,
            FULL_AMOUNT.div(2),
            AMOUNT_OF_SWAPS,
            SWAP_INTERVAL,
            DCAFeeManager.address,
            []
          );
        });
        then('deposit with token B is made correctly', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledWith(
            erc20Token.address,
            TOKEN_B,
            FULL_AMOUNT.div(2),
            AMOUNT_OF_SWAPS,
            SWAP_INTERVAL,
            DCAFeeManager.address,
            []
          );
        });
        then('there were only two deposits made', () => {
          expect(DCAHub['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])']).to.have.been.calledTwice;
        });
        then('position is stored for the pair with token A', async () => {
          const key = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_A);
          expect(await DCAFeeManager.positions(key)).to.equal(POSITION_ID_TOKEN_A);
        });
        then('position is stored for the pair with token B', async () => {
          const key = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_B);
          expect(await DCAFeeManager.positions(key)).to.equal(POSITION_ID_TOKEN_B);
        });
        then('position is stored for token A', async () => {
          const positions = await DCAFeeManager.positionsWithToken(TOKEN_A);
          expect(positions).to.eql([BigNumber.from(POSITION_ID_TOKEN_A)]);
        });
        then('position is stored for token B', async () => {
          const positions = await DCAFeeManager.positionsWithToken(TOKEN_A);
          expect(positions).to.eql([BigNumber.from(POSITION_ID_TOKEN_A)]);
        });
      });
    });

    when('there is a position created', () => {
      given(async () => {
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_A, POSITION_ID_TOKEN_A);
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_B, POSITION_ID_TOKEN_B);
      });
      describe('and increase fails', () => {
        given(async () => {
          DCAHub.increasePosition.revertsAtCall(0);
          await DCAFeeManager.connect(governor).fillPositions(
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('full amount is spent on last target token', () => {
          expect(DCAHub.increasePosition).to.have.been.calledTwice;
          expect(DCAHub.increasePosition).to.have.been.calledWith(POSITION_ID_TOKEN_B, FULL_AMOUNT, AMOUNT_OF_SWAPS);
        });
      });
      describe('and increase works', () => {
        given(async () => {
          await DCAFeeManager.connect(governor).fillPositions(
            [{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }],
            DISTRIBUTION
          );
        });
        then('increase with token A is made correctly', () => {
          expect(DCAHub.increasePosition).to.have.been.calledWith(POSITION_ID_TOKEN_A, FULL_AMOUNT.div(2), AMOUNT_OF_SWAPS);
        });
        then('increase with token B is made correctly', () => {
          expect(DCAHub.increasePosition).to.have.been.calledWith(POSITION_ID_TOKEN_B, FULL_AMOUNT.div(2), AMOUNT_OF_SWAPS);
        });
        then('there were only two increases made', () => {
          expect(DCAHub.increasePosition).to.have.been.calledTwice;
        });
      });
    });

    shouldOnlyBeExecutableByGovernorOrAllowed({
      funcAndSignature: 'fillPositions',
      params: () => [[{ token: erc20Token.address, amount: FULL_AMOUNT, amountOfSwaps: AMOUNT_OF_SWAPS }], DISTRIBUTION],
    });
  });

  describe('terminatePositions', () => {
    const RECIPIENT = wallet.generateRandomAddress();
    const POSITION_IDS = [1, 2];
    when('function is executed', () => {
      given(async () => {
        DCAHub.userPosition.returns(({ _positionId }: { _positionId: BigNumber }) => ({
          from: erc20Token.address,
          to: _positionId.eq(1) ? TOKEN_A : TOKEN_B,
          swapInterval: constants.Zero,
          swapsExecuted: constants.Zero,
          swapped: constants.Zero,
          swapsLeft: constants.Zero,
          remaining: constants.Zero,
          rate: constants.Zero,
        }));
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_A, 1);
        await DCAFeeManager.setPosition(erc20Token.address, TOKEN_B, 2);
        await DCAFeeManager.connect(governor).terminatePositions(POSITION_IDS, RECIPIENT);
      });
      then('position 1 is terminated and deleted from fee manager', async () => {
        expect(DCAHub.terminate).to.have.been.calledWith(1, RECIPIENT, RECIPIENT);
        const positionKey = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_A);
        expect(await DCAFeeManager.positions(positionKey)).to.equal(0);
      });
      then('position 2 is terminated and deleted from fee manager', async () => {
        expect(DCAHub.terminate).to.have.been.calledWith(2, RECIPIENT, RECIPIENT);
        const positionKey = await DCAFeeManager.getPositionKey(erc20Token.address, TOKEN_B);
        expect(await DCAFeeManager.positions(positionKey)).to.equal(0);
      });
      then('only two positions were terminated', () => {
        expect(DCAHub.terminate).to.have.been.calledTwice;
      });
    });
    shouldOnlyBeExecutableByGovernorOrAllowed({
      funcAndSignature: 'terminatePositions',
      params: [[], RECIPIENT],
    });
  });

  describe('setAccess', () => {
    const USER = wallet.generateRandomAddress();
    when('giving access to a user', () => {
      let tx: TransactionResponse;
      given(async () => {
        tx = await DCAFeeManager.connect(governor).setAccess([{ user: USER, access: true }]);
      });
      then('user has access', async () => {
        expect(await DCAFeeManager.hasAccess(USER)).to.be.true;
      });
      then('event is emitted', async () => {
        await expect(tx).to.emit(DCAFeeManager, 'NewAccess');
        // Can't compare array of objects directly, so will read the arg and compare manually
        const access: IDCAFeeManager.UserAccessStruct[] = await readArgFromEventOrFail(tx, 'NewAccess', 'access');
        expect(access).to.have.lengthOf(1);
        expect(access[0].user).to.equal(USER);
        expect(access[0].access).to.equal(true);
      });
    });
    when('taking access from a user', () => {
      let tx: TransactionResponse;
      given(async () => {
        await DCAFeeManager.connect(governor).setAccess([{ user: USER, access: true }]);
        tx = await DCAFeeManager.connect(governor).setAccess([{ user: USER, access: false }]);
      });
      then('user lost access', async () => {
        expect(await DCAFeeManager.hasAccess(USER)).to.be.false;
      });
      then('event is emitted', async () => {
        await expect(tx).to.emit(DCAFeeManager, 'NewAccess');
        // Can't compare array of objects directly, so will read the arg and compare manually
        const access: IDCAFeeManager.UserAccessStruct[] = await readArgFromEventOrFail(tx, 'NewAccess', 'access');
        expect(access).to.have.lengthOf(1);
        expect(access[0].user).to.equal(USER);
        expect(access[0].access).to.equal(false);
      });
    });
    behaviours.shouldBeExecutableOnlyByGovernor({
      contract: () => DCAFeeManager,
      funcAndSignature: 'setAccess',
      params: () => [[{ user: random.address, access: true }]],
      governor: () => governor,
    });
  });

  describe('resetAllowance', () => {
    when('function is executed', () => {
      given(async () => {
        await DCAFeeManager.resetAllowance(erc20Token.address);
      });
      then('allowance is reset', async () => {
        expect(erc20Token.approve).to.have.been.calledTwice;
        expect(erc20Token.approve).to.have.been.calledWith(DCAHub.address, 0);
        expect(erc20Token.approve).to.have.been.calledWith(DCAHub.address, constants.MaxUint256);
      });
    });
  });

  describe('availableBalances', () => {
    when('function is executed', () => {
      const PLATFORM_BALANCE = utils.parseEther('1');
      const FEE_MANAGER_BALANCE = utils.parseEther('2');
      let position1: IDCAHubPositionHandler.UserPositionStruct, position2: IDCAHubPositionHandler.UserPositionStruct;
      given(async () => {
        DCAHub.platformBalance.returns(PLATFORM_BALANCE);
        erc20Token.balanceOf.returns(FEE_MANAGER_BALANCE);
        position1 = positionWith(TOKEN_A, erc20Token.address, utils.parseEther('1'));
        position2 = positionWith(TOKEN_B, erc20Token.address, utils.parseEther('3'));
        DCAHub.userPosition.returns(({ _positionId }: { _positionId: BigNumber }) => (_positionId.eq(1) ? position1 : position2));
        await DCAFeeManager.setPositionsWithToken(erc20Token.address, [1, 2]);
      });
      then('balances are returned correctly', async () => {
        const balances = await DCAFeeManager.availableBalances([erc20Token.address]);
        expect(balances).to.have.lengthOf(1);
        expect(balances[0].token).to.equal(erc20Token.address);
        expect(balances[0].platformBalance).to.equal(PLATFORM_BALANCE);
        expect(balances[0].feeManagerBalance).to.equal(FEE_MANAGER_BALANCE);
        expect(balances[0].positions).to.have.lengthOf(2);
        expectUserPositionToBeEqual(balances[0].positions[0], position1, 1);
        expectUserPositionToBeEqual(balances[0].positions[1], position2, 2);
      });
    });

    function expectUserPositionToBeEqual(
      actual: IDCAFeeManager.PositionBalanceStructOutput,
      expected: IDCAHubPositionHandler.UserPositionStruct,
      positionId: BigNumberish
    ) {
      expect(actual.positionId).to.equal(positionId);
      expect(actual.from).to.equal(expected.from);
      expect(actual.to).to.equal(expected.to);
      expect(actual.swapped).to.equal(expected.swapped);
      expect(actual.remaining).to.equal(expected.remaining);
    }

    function positionWith(from: string, to: string, swapped: BigNumberish) {
      return {
        from,
        to,
        swapInterval: constants.Zero,
        swapsExecuted: constants.Zero,
        swapped,
        swapsLeft: constants.Zero,
        remaining: constants.Zero,
        rate: constants.Zero,
      };
    }
  });

  function shouldOnlyBeExecutableByGovernorOrAllowed({
    funcAndSignature,
    params,
  }: {
    funcAndSignature: string;
    params?: any[] | (() => any[]);
  }) {
    let realParams: any[];
    given(() => {
      realParams = typeof params === 'function' ? params() : params ?? [];
    });
    when('called from allowed', () => {
      let onlyAllowed: Promise<TransactionResponse>;
      given(async () => {
        await DCAFeeManager.connect(governor).setAccess([{ user: random.address, access: true }]);
        onlyAllowed = (DCAFeeManager as any).connect(random)[funcAndSignature](...realParams!);
      });
      then(`tx is not reverted or not reverted with reason 'CallerMustBeOwnerOrHaveAccess'`, async () => {
        await expect(onlyAllowed).to.not.be.revertedWith('CallerMustBeOwnerOrHaveAccess');
      });
    });
    when('called by governor', () => {
      let onlyGovernor: Promise<TransactionResponse>;
      given(async () => {
        onlyGovernor = (DCAFeeManager as any).connect(governor)[funcAndSignature](...realParams!);
      });
      then(`tx is not reverted or not reverted with reason 'CallerMustBeOwnerOrHaveAccess'`, async () => {
        await expect(onlyGovernor).to.not.be.revertedWith('CallerMustBeOwnerOrHaveAccess');
      });
    });
    when('not called from allowed or governor', () => {
      let onlyGovernorAllowedTx: Promise<TransactionResponse>;
      given(async () => {
        const notAllowed = await wallet.generateRandom();
        onlyGovernorAllowedTx = (DCAFeeManager as any).connect(notAllowed)[funcAndSignature](...realParams!);
      });
      then('tx is reverted with reason', async () => {
        await expect(onlyGovernorAllowedTx).to.be.revertedWith('CallerMustBeOwnerOrHaveAccess');
      });
    });
  }

  function getProtocolBalance(address: string) {
    return ethers.provider.getBalance(address);
  }

  async function setProtocolBalance(recipient: { address: string }, amount: BigNumber) {
    await ethers.provider.send('hardhat_setBalance', [recipient.address, ethers.utils.hexValue(amount)]);
    return BigNumber.from(amount);
  }

  type AmountToWithdraw = { token: string; amount: BigNumberish };
  function expectAmounToWithdrawToBe(actual: AmountToWithdraw[], expected: AmountToWithdraw[]) {
    expect(actual).to.have.lengthOf(expected.length);
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i].token).to.equal(expected[i].token);
      expect(actual[i].amount).to.equal(expected[i].amount);
    }
  }

  type PositionSet = { token: string; positionIds: BigNumberish[] };
  function expectPositionSetsToBe(actual: PositionSet[], expected: PositionSet[]) {
    expect(actual).to.have.lengthOf(expected.length);
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i].token).to.equal(expected[i].token);
      expect(actual[i].positionIds).to.eql(expected[i].positionIds.map(BigNumber.from));
    }
  }
});
