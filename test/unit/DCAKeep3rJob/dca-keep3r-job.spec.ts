import chai, { expect } from 'chai';
import { ethers } from 'hardhat';
import { behaviours, constants, wallet } from '@test-utils';
import { contract, given, then, when } from '@test-utils/bdd';
import { snapshot } from '@test-utils/evm';
import { DCAKeep3rJobMock, DCAKeep3rJobMock__factory, IKeep3rJobs } from '@typechained';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { FakeContract, smock } from '@defi-wonderland/smock';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { BigNumber, BigNumberish, BytesLike, utils, Wallet } from 'ethers';
import moment from 'moment';

chai.use(smock.matchers);

contract('DCAKeep3rJob', () => {
  const SWAPPER = wallet.generateRandomAddress();
  let governor: SignerWithAddress, signer: SignerWithAddress, random: SignerWithAddress;
  let DCAKeep3rJob: DCAKeep3rJobMock;
  let DCAKeep3rJobFactory: DCAKeep3rJobMock__factory;
  let keep3r: FakeContract<IKeep3rJobs>;
  let chainId: BigNumber;
  let snapshotId: string;

  before('Setup accounts and contracts', async () => {
    [, governor, signer, random] = await ethers.getSigners();
    keep3r = await smock.fake('IKeep3rJobs');
    DCAKeep3rJobFactory = await ethers.getContractFactory('contracts/mocks/DCAKeep3rJob/DCAKeep3rJob.sol:DCAKeep3rJobMock');
    DCAKeep3rJob = await DCAKeep3rJobFactory.deploy(SWAPPER, keep3r.address, governor.address);
    chainId = BigNumber.from((await ethers.provider.getNetwork()).chainId);
    snapshotId = await snapshot.take();
  });

  beforeEach('Deploy and configure', async () => {
    await snapshot.revert(snapshotId);
    keep3r.isKeeper.reset();
    keep3r.worked.reset();
  });

  describe('constructor', () => {
    when('swapper is zero address', () => {
      then('deployment should not revert', async () => {
        const deploymentTx = DCAKeep3rJobFactory.getDeployTransaction(constants.ZERO_ADDRESS, keep3r.address, governor.address);
        await expect(DCAKeep3rJobFactory.signer.sendTransaction(deploymentTx)).to.not.be.reverted;
      });
    });
    when('keep3r is zero address', () => {
      then('deployment is reverted with reason', async () => {
        await behaviours.deployShouldRevertWithMessage({
          contract: DCAKeep3rJobFactory,
          args: [SWAPPER, constants.ZERO_ADDRESS, governor.address],
          message: 'ZeroAddress',
        });
      });
    });
    when('contract is initiated', () => {
      then('swapper is set correctly', async () => {
        expect(await DCAKeep3rJob.swapper()).to.equal(SWAPPER);
      });
      then('keep3r is set correctly', async () => {
        expect(await DCAKeep3rJob.keep3r()).to.equal(keep3r.address);
      });
      then('no address can sign work', async () => {
        expect(await DCAKeep3rJob.canAddressSignWork(signer.address)).to.be.false;
      });
      then('nonce starts at 0', async () => {
        expect(await DCAKeep3rJob.nonce()).to.equal(0);
      });
    });
  });
  describe('setIfAddressCanSign', () => {
    when('zero address is sent', () => {
      then('reverts with message', async () => {
        await behaviours.txShouldRevertWithMessage({
          contract: DCAKeep3rJob.connect(governor),
          func: 'setIfAddressCanSign',
          args: [constants.ZERO_ADDRESS, true],
          message: 'ZeroAddress',
        });
      });
    });
    when('adding permission to an address', () => {
      let tx: TransactionResponse;
      given(async () => {
        tx = await DCAKeep3rJob.connect(governor).setIfAddressCanSign(signer.address, true);
      });
      then('it is set correctly', async () => {
        expect(await DCAKeep3rJob.canAddressSignWork(signer.address)).to.be.true;
      });
      then('event is emitted', async () => {
        await expect(tx).to.emit(DCAKeep3rJob, 'ModifiedAddressPermission').withArgs(signer.address, true);
      });
    });
    when('removing permission to an address', () => {
      let tx: TransactionResponse;
      given(async () => {
        await DCAKeep3rJob.connect(governor).setIfAddressCanSign(signer.address, true);
        tx = await DCAKeep3rJob.connect(governor).setIfAddressCanSign(signer.address, false);
      });
      then('it is set correctly', async () => {
        expect(await DCAKeep3rJob.canAddressSignWork(signer.address)).to.be.false;
      });
      then('event is emitted', async () => {
        await expect(tx).to.emit(DCAKeep3rJob, 'ModifiedAddressPermission').withArgs(signer.address, false);
      });
    });
    behaviours.shouldBeExecutableOnlyByGovernor({
      contract: () => DCAKeep3rJob,
      funcAndSignature: 'setIfAddressCanSign',
      params: () => [constants.NOT_ZERO_ADDRESS, true],
      governor: () => governor,
    });
  });
  describe('setSwapper', () => {
    when('zero address is sent', () => {
      then('reverts with message', async () => {
        await behaviours.txShouldRevertWithMessage({
          contract: DCAKeep3rJob.connect(governor),
          func: 'setSwapper',
          args: [constants.ZERO_ADDRESS],
          message: 'ZeroAddress',
        });
      });
    });
    when('a valid address is sent', () => {
      const NEW_SWAPPER = constants.NOT_ZERO_ADDRESS;
      let tx: TransactionResponse;
      given(async () => {
        tx = await DCAKeep3rJob.connect(governor).setSwapper(NEW_SWAPPER);
      });
      then('it is set correctly', async () => {
        expect(await DCAKeep3rJob.swapper()).to.equal(NEW_SWAPPER);
      });
      then('event is emitted', async () => {
        await expect(tx).to.emit(DCAKeep3rJob, 'NewSwapperSet').withArgs(NEW_SWAPPER);
      });
    });
    behaviours.shouldBeExecutableOnlyByGovernor({
      contract: () => DCAKeep3rJob,
      funcAndSignature: 'setSwapper',
      params: () => [constants.NOT_ZERO_ADDRESS],
      governor: () => governor,
    });
  });
  describe('setKeep3r', () => {
    when('zero address is sent', () => {
      then('reverts with message', async () => {
        await behaviours.txShouldRevertWithMessage({
          contract: DCAKeep3rJob.connect(governor),
          func: 'setKeep3r',
          args: [constants.ZERO_ADDRESS],
          message: 'ZeroAddress',
        });
      });
    });
    when('a valid address is sent', () => {
      const NEW_KEEP3R = constants.NOT_ZERO_ADDRESS;
      let tx: TransactionResponse;
      given(async () => {
        tx = await DCAKeep3rJob.connect(governor).setKeep3r(NEW_KEEP3R);
      });
      then('it is set correctly', async () => {
        expect(await DCAKeep3rJob.keep3r()).to.equal(NEW_KEEP3R);
      });
      then('event is emitted', async () => {
        await expect(tx).to.emit(DCAKeep3rJob, 'NewKeep3rSet').withArgs(NEW_KEEP3R);
      });
    });
    behaviours.shouldBeExecutableOnlyByGovernor({
      contract: () => DCAKeep3rJob,
      funcAndSignature: 'setKeep3r',
      params: () => [constants.NOT_ZERO_ADDRESS],
      governor: () => governor,
    });
  });
  describe('work', () => {
    given(async () => {
      await DCAKeep3rJob.connect(governor).setIfAddressCanSign(signer.address, true);
    });

    workFailsTest({
      when: 'caller is not a keep3r',
      signer: () => signer,
      callerIsNotAKeeper: true,
      txFailsWith: 'NotAKeeper',
    });
    workFailsTest({
      when: 'signer is not allowed to sign',
      signer: () => random,
      txFailsWith: 'SignerCannotSignWork',
    });
    workFailsTest({
      when: 'nonce is invalid',
      signer: () => signer,
      nonce: 10,
      txFailsWith: 'InvalidNonce',
    });
    workFailsTest({
      when: 'deadline has expired',
      signer: () => signer,
      deadline: 0,
      txFailsWith: 'DeadlineExpired',
    });
    workFailsTest({
      when: 'chain id is invalid',
      signer: () => signer,
      chainId: 69,
      txFailsWith: 'InvalidChainId',
    });

    when('work is called correctly', () => {
      const CALL: WorkCall = { call: utils.hexlify(utils.randomBytes(10)), nonce: 0, chainId, deadline: constants.MAX_UINT_256 };
      let caller: Wallet;
      given(async () => {
        caller = await wallet.generateRandom();
        const { bytes, signature } = await sign(signer, CALL);
        keep3r.isKeeper.returns(true);
        await DCAKeep3rJob.connect(caller).work(bytes, signature);
      });
      then('nonce is increased', async () => {
        expect(await DCAKeep3rJob.nonce()).to.equal(1);
      });
      then('swapper is called correctly', async () => {
        expect(await DCAKeep3rJob.swapperCalledWith()).to.equal(CALL.call);
      });
      then('worked is called', () => {
        expect(keep3r.worked).to.have.been.calledOnceWith(caller.address);
      });
    });

    function workFailsTest({
      when: title,
      signer,
      txFailsWith,
      callerIsNotAKeeper,
      ...call
    }: { when: string; signer: () => SignerWithAddress; callerIsNotAKeeper?: boolean; txFailsWith: string } & Partial<WorkCall>) {
      when(title, () => {
        given(() => keep3r.isKeeper.returns(!callerIsNotAKeeper));
        then('reverts with message', async () => {
          const { bytes, signature } = await sign(signer(), call);
          await behaviours.txShouldRevertWithMessage({
            contract: DCAKeep3rJob,
            func: 'work',
            args: [bytes, signature],
            message: txFailsWith,
          });
        });
      });
    }

    async function sign(signer: SignerWithAddress, call: Partial<WorkCall>) {
      const bytes = encode(call);
      const messageHash = ethers.utils.solidityKeccak256(['bytes'], [bytes]);
      const signature = await signer.signMessage(ethers.utils.arrayify(messageHash));
      return { bytes, signature };
    }
    function encode({ call, nonce, chainId: sentChainId, deadline }: Partial<WorkCall>) {
      const coder = new ethers.utils.AbiCoder();
      return coder.encode(
        ['tuple(bytes, uint256, uint256, uint256)'],
        [[call ?? '0x', nonce ?? 0, sentChainId ?? chainId, deadline ?? constants.MAX_UINT_256]]
      );
    }
    type WorkCall = { call: BytesLike; nonce: number; chainId: BigNumberish; deadline: BigNumberish };
  });
});
