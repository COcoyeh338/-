import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';

import { bn, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { MAX_UINT256, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';

import { AssetHelpers, WeightedPoolEncoder } from '@balancer-labs/balancer-js';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { expectBalanceChange } from '@balancer-labs/v2-helpers/src/test/tokenBalance';
import { advanceTime } from '@balancer-labs/v2-helpers/src/time';
import { setup, tokenInitialBalance, rewardsDuration, rewardsVestingTime } from './MultiRewardsSharedSetup';

describe('Reinvestor', () => {
  let admin: SignerWithAddress, lp: SignerWithAddress, mockAssetManager: SignerWithAddress;

  let rewardTokens: TokenList;
  let vault: Contract;
  let stakingContract: Contract;
  let callbackContract: Contract;
  let rewardToken: Token;
  let pool: Contract;

  before('deploy base contracts', async () => {
    [, admin, lp, mockAssetManager] = await ethers.getSigners();
  });

  sharedBeforeEach('set up asset manager and reinvestor', async () => {
    const { contracts } = await setup();

    pool = contracts.pool;
    vault = contracts.vault;
    stakingContract = contracts.stakingContract;
    rewardToken = contracts.rewardTokens.DAI;
    rewardTokens = contracts.rewardTokens;

    callbackContract = await deploy('Reinvestor', { args: [vault.address] });
  });

  describe('with a stake and a reward', () => {
    let id: string;
    const rewardAmount = fp(1);

    sharedBeforeEach(async () => {
      await stakingContract.connect(mockAssetManager).addReward(pool.address, rewardToken.address, rewardsDuration);

      const bptBalance = await pool.balanceOf(lp.address);

      await pool.connect(lp).approve(stakingContract.address, bptBalance);

      id = await stakingContract.getDistributionId(pool.address, rewardToken.address, mockAssetManager.address);
      await stakingContract.connect(lp).subscribe([id]);
      await stakingContract.connect(lp).stake(pool.address, bptBalance);

      await stakingContract
        .connect(mockAssetManager)
        .notifyRewardAmount(pool.address, rewardToken.address, rewardAmount);
      await advanceTime(rewardsVestingTime);
    });

    describe('with a pool to claim into', () => {
      let destinationPool: Contract;
      let destinationPoolId: string;
      let assets: string[];

      sharedBeforeEach(async () => {
        // Creating a BAT-DAI pool
        const tokens = await TokenList.create(['BAT']);
        await tokens.mint({ to: lp, amount: tokenInitialBalance });
        await tokens.approve({ to: vault.address, from: [lp] });

        await rewardTokens.mint({ to: lp, amount: tokenInitialBalance });
        await rewardTokens.approve({ to: vault.address, from: [lp] });

        [assets] = new AssetHelpers(ZERO_ADDRESS).sortTokens([rewardToken.address, tokens.BAT.address]);
        const weights = [fp(0.5), fp(0.5)];
        const assetManagers = [ZERO_ADDRESS, ZERO_ADDRESS];

        destinationPool = await deploy('v2-pool-weighted/WeightedPool', {
          args: [
            vault.address,
            'Reinvestment Pool',
            'REINVEST',
            assets,
            weights,
            assetManagers,
            fp(0.0001),
            0,
            0,
            admin.address,
          ],
        });

        destinationPoolId = await destinationPool.getPoolId();

        await vault.connect(lp).joinPool(destinationPoolId, lp.address, lp.address, {
          assets,
          maxAmountsIn: Array(assets.length).fill(MAX_UINT256),
          fromInternalBalance: false,
          userData: WeightedPoolEncoder.joinInit(Array(assets.length).fill(tokenInitialBalance)),
        });
      });

      it('emits PoolBalanceChanged when a LP claims to weighted pool', async () => {
        const args = [lp.address, destinationPoolId, [rewardToken.address]];
        const calldata = utils.defaultAbiCoder.encode(['(address,bytes32,address[])'], [args]);

        const receipt = await (
          await stakingContract.connect(lp).getRewardWithCallback([id], callbackContract.address, calldata)
        ).wait();

        const deltas = [bn(0), bn(0)];
        deltas[assets.indexOf(rewardToken.address)] = bn('999999999999999498');

        expectEvent.inIndirectReceipt(receipt, vault.interface, 'PoolBalanceChanged', {
          poolId: destinationPoolId,
          liquidityProvider: callbackContract.address,
          tokens: assets,
          deltas,
          protocolFeeAmounts: [0, 0],
        });
      });

      it('mints bpt to a LP when they claim to weighted pool', async () => {
        const bptBalanceBefore = await destinationPool.balanceOf(lp.address);
        const args = [lp.address, destinationPoolId, [rewardToken.address]];
        const calldata = utils.defaultAbiCoder.encode(['(address,bytes32,address[])'], [args]);

        await stakingContract.connect(lp).getRewardWithCallback([id], callbackContract.address, calldata);
        const bptBalanceAfter = await destinationPool.balanceOf(lp.address);
        expect(bptBalanceAfter.sub(bptBalanceBefore)).to.equal(bn('998703239790478024'));
      });

      describe('addReward', () => {
        let anotherId: string;
        let otherRewardTokens: TokenList;
        let otherRewardToken: Token;

        sharedBeforeEach('with multiple rewardTokens', async () => {
          otherRewardTokens = await TokenList.create(['GRT'], { sorted: true });
          otherRewardToken = otherRewardTokens.GRT;

          await otherRewardTokens.mint({ to: mockAssetManager, amount: bn(100e18) });
          await otherRewardTokens.approve({ to: stakingContract.address, from: [mockAssetManager] });

          await stakingContract
            .connect(mockAssetManager)
            .addReward(pool.address, otherRewardToken.address, rewardsDuration);

          anotherId = await stakingContract.getDistributionId(
            pool.address,
            otherRewardToken.address,
            mockAssetManager.address
          );
          await stakingContract.connect(lp).subscribe([anotherId]);

          await stakingContract
            .connect(mockAssetManager)
            .notifyRewardAmount(pool.address, otherRewardToken.address, fp(3));
          await advanceTime(rewardsVestingTime);
        });

        it('returns rewards that are unused in reinvestment', async () => {
          const rewardTokenAddresses = [rewardToken.address, otherRewardToken.address];
          const args = [lp.address, destinationPoolId, rewardTokenAddresses];
          const calldata = utils.defaultAbiCoder.encode(['(address,bytes32,address[])'], [args]);

          await expectBalanceChange(
            () =>
              stakingContract.connect(lp).getRewardWithCallback([id, anotherId], callbackContract.address, calldata),
            otherRewardTokens,
            [{ account: lp, changes: { GRT: ['very-near', fp(3)] } }]
          );
        });
      });
    });
  });
});
