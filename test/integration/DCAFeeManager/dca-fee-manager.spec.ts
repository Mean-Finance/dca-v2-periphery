import { expect } from 'chai';
import { deployments, ethers, getNamedAccounts } from 'hardhat';
import { JsonRpcSigner } from '@ethersproject/providers';
import { constants, wallet } from '@test-utils';
import { contract } from '@test-utils/bdd';
import evm from '@test-utils/evm';
import { DCAHubSwapper, IERC20, DCAFeeManager } from '@typechained';
import { DCAHub } from '@mean-finance/dca-v2-core/typechained';
import { abi as IERC20_ABI } from '@openzeppelin/contracts/build/contracts/IERC20.json';
import { BigNumber, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { SwapInterval } from '@test-utils/interval-utils';
import forkBlockNumber from '@integration/fork-block-numbers';
import { DeterministicFactory, DeterministicFactory__factory } from '@mean-finance/deterministic-factory/typechained';
import { buildSwapInput } from '@test-utils/swap-utils';

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WBTC_ADDRESS = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const WETH_WHALE_ADDRESS = '0xf04a5cc80b1e94c69b48f5ee68a08cd2f09a7c3e';
const USDC_WHALE_ADDRESS = '0xcffad3200574698b78f32232aa9d63eabd290703';
const WBTC_WHALE_ADDRESS = '0x9ff58f4ffb29fa2266ab25e75e2a8b3503311656';

contract('DCAFeeManager', () => {
  const RECIPIENT = wallet.generateRandomAddress();
  let WETH: IERC20, USDC: IERC20, WBTC: IERC20;
  let governor: JsonRpcSigner;
  let cindy: SignerWithAddress, allowed: SignerWithAddress, swapper: SignerWithAddress;
  let DCAFeeManager: DCAFeeManager;
  let DCAHubSwapper: DCAHubSwapper;
  let DCAHub: DCAHub;

  before(async () => {
    await evm.reset({
      network: 'mainnet',
      blockNumber: forkBlockNumber['swap-for-caller'],
      skipHardhatDeployFork: true,
    });
    [cindy, allowed, swapper] = await ethers.getSigners();

    const namedAccounts = await getNamedAccounts();
    const governorAddress = namedAccounts.governor;
    governor = await wallet.impersonate(governorAddress);
    await ethers.provider.send('hardhat_setBalance', [governorAddress, '0xffffffffffffffff']);

    const deterministicFactory = await ethers.getContractAt<DeterministicFactory>(
      DeterministicFactory__factory.abi,
      '0xbb681d77506df5CA21D2214ab3923b4C056aa3e2'
    );

    await deterministicFactory.connect(governor).grantRole(await deterministicFactory.DEPLOYER_ROLE(), namedAccounts.deployer);

    await deployments.run(['DCAHub', 'DCAHubSwapper', 'DCAFeeManager'], {
      resetMemory: true,
      deletePreviousDeployments: false,
      writeDeploymentsToFiles: false,
    });

    DCAHub = await ethers.getContract('DCAHub');
    DCAHubSwapper = await ethers.getContract('DCAHubSwapper');
    DCAFeeManager = await ethers.getContract('DCAFeeManager');

    // Set up tokens and permissions
    await DCAHub.connect(governor).setAllowedTokens([WETH_ADDRESS, USDC_ADDRESS, WBTC_ADDRESS], [true, true, true]);
    await DCAHub.connect(governor).grantRole(await DCAHub.PLATFORM_WITHDRAW_ROLE(), DCAFeeManager.address);
    await DCAFeeManager.connect(governor).setAccess([{ user: allowed.address, access: true }]);

    WETH = await ethers.getContractAt(IERC20_ABI, WETH_ADDRESS);
    USDC = await ethers.getContractAt(IERC20_ABI, USDC_ADDRESS);
    WBTC = await ethers.getContractAt(IERC20_ABI, WBTC_ADDRESS);

    // Send tokens from whales, to our users
    await distributeTokensToUsers();

    // Handle approvals
    await USDC.connect(swapper).approve(DCAHubSwapper.address, constants.MAX_UINT_256);
    await WETH.connect(swapper).approve(DCAHubSwapper.address, constants.MAX_UINT_256);
    await WBTC.connect(cindy).approve(DCAHub.address, constants.MAX_UINT_256);
  });

  it('swap, convert and withdraw as protocol token', async () => {
    // Deposit
    await DCAHub.connect(cindy)['deposit(address,address,uint256,uint32,uint32,address,(address,uint8[])[])'](
      WBTC.address,
      USDC.address,
      utils.parseUnits('0.1', 6),
      1,
      SwapInterval.ONE_DAY.seconds,
      cindy.address,
      []
    );

    // Execute swap
    await swap({ from: WBTC, to: USDC });

    // Calculate and verify balances
    const [usdcBalance, wbtcBalance] = await DCAFeeManager.availableBalances([USDC.address, WBTC.address]);
    expect(usdcBalance.platformBalance.gt(0)).to.be.true;
    expect(usdcBalance.feeManagerBalance).to.equal(0);
    expect(wbtcBalance.platformBalance).to.equal(0);
    expect(wbtcBalance.feeManagerBalance.gt(0)).to.be.true;

    // Prepare data to withdraw USDC from platform balance
    const { data: withdrawData } = await DCAFeeManager.populateTransaction.withdrawFromPlatformBalance(
      [{ token: USDC.address, amount: usdcBalance.platformBalance }],
      DCAFeeManager.address
    );

    // Prepare data to send WBTC and USDC to Hub, to DCA for WETH
    const { data: fillData } = await DCAFeeManager.populateTransaction.fillPositions(
      [
        { token: USDC.address, amount: usdcBalance.platformBalance, amountOfSwaps: 1 },
        { token: WBTC.address, amount: wbtcBalance.feeManagerBalance, amountOfSwaps: 1 },
      ],
      [{ token: WETH.address, shares: 10000 }]
    );

    // Execute withdraw + fill
    await DCAFeeManager.connect(allowed).multicall([withdrawData!, fillData!]);

    // Execute swap
    await swap({ from: USDC, to: WETH }, { from: WBTC, to: WETH });

    // Check position balances
    const [position2, position3] = await DCAFeeManager.positionBalances([2, 3]);
    expect(position2.from.toLowerCase()).to.equal(USDC.address.toLowerCase());
    expect(position2.to.toLowerCase()).to.eql(WETH.address.toLowerCase());
    expect(position2.swappedBalance.gt(0)).to.be.true;
    expect(position3.from.toLowerCase()).to.equal(WBTC.address.toLowerCase());
    expect(position3.to.toLowerCase()).to.equal(WETH.address.toLowerCase());
    expect(position3.swappedBalance.gt(0)).to.be.true;

    // Check platform balance
    const wethPlatformBalance = await DCAHub.platformBalance(WETH.address);
    expect(wethPlatformBalance.gt(0)).to.be.true;

    // Execute withdraw as protocol token
    await DCAFeeManager.connect(allowed).withdrawProtocolToken([2, 3], RECIPIENT);

    // Make sure that everything was transferred to recipient
    const recipientBalance = await ethers.provider.getBalance(RECIPIENT);
    const [position2After, position3After] = await DCAFeeManager.positionBalances([2, 3]);
    expect(recipientBalance).to.equal(wethPlatformBalance.add(position2.swappedBalance).add(position3.swappedBalance));
    expect(position2After.swappedBalance).to.equal(0);
    expect(position3After.swappedBalance).to.equal(0);
    expect(await DCAHub.platformBalance(WETH.address)).to.equal(0);
  });

  async function distributeTokensToUsers() {
    const wethWhale = await wallet.impersonate(WETH_WHALE_ADDRESS);
    const usdcWhale = await wallet.impersonate(USDC_WHALE_ADDRESS);
    const wbtcWhale = await wallet.impersonate(WBTC_WHALE_ADDRESS);
    await ethers.provider.send('hardhat_setBalance', [WBTC_WHALE_ADDRESS, '0xffffffffffffffff']);
    await ethers.provider.send('hardhat_setBalance', [WETH_WHALE_ADDRESS, '0xffffffffffffffff']);
    await ethers.provider.send('hardhat_setBalance', [USDC_WHALE_ADDRESS, '0xffffffffffffffff']);
    await WBTC.connect(wbtcWhale).transfer(cindy.address, BigNumber.from(10).pow(12));
    await WETH.connect(wethWhale).transfer(swapper.address, BigNumber.from(10).pow(22));
    await USDC.connect(usdcWhale).transfer(swapper.address, BigNumber.from(10).pow(12));
  }

  async function swap(...pairs: { from: IERC20; to: IERC20 }[]) {
    const { tokens, pairIndexes } = buildSwapInput(
      pairs.map(({ from, to }) => ({ tokenA: from.address, tokenB: to.address })),
      []
    );
    await DCAHubSwapper.connect(swapper).swapForCaller(
      tokens,
      pairIndexes,
      tokens.map((_) => 0),
      tokens.map((_) => constants.MAX_UINT_256),
      DCAFeeManager.address,
      constants.MAX_UINT_256
    );
  }
});
