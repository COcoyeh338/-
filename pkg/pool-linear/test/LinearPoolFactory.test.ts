import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { fp } from '@balancer-labs/v2-helpers/src/numbers';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { MAX_UINT112, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { advanceTime, currentTimestamp, MONTH } from '@balancer-labs/v2-helpers/src/time';

describe('LinearPoolFactory', function () {
  let vault: Vault, tokens: TokenList, factory: Contract;
  let creationTime: BigNumber, wrappedTokenRateProvider: string, owner: SignerWithAddress;

  const NAME = 'Balancer Linear Pool Token';
  const SYMBOL = 'LPT';
  const LOWER_TARGET = fp(1000);
  const UPPER_TARGET = fp(2000);
  const POOL_SWAP_FEE_PERCENTAGE = fp(0.01);
  const BASE_PAUSE_WINDOW_DURATION = MONTH * 3;
  const BASE_BUFFER_PERIOD_DURATION = MONTH;
  const WRAPPED_TOKEN_RATE_CACHE_DURATION = MONTH;

  before('setup signers', async () => {
    [, owner] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy factory & tokens', async () => {
    vault = await Vault.create();
    factory = await deploy('LinearPoolFactory', { args: [vault.address] });
    creationTime = await currentTimestamp();

    tokens = await TokenList.create(['DAI', 'CDAI'], { sorted: true });
    wrappedTokenRateProvider = (await deploy('v2-pool-utils/MockRateProvider')).address;
  });

  async function createPool(): Promise<Contract> {
    const receipt = await factory.create(
      NAME,
      SYMBOL,
      tokens.DAI.address,
      tokens.CDAI.address,
      LOWER_TARGET,
      UPPER_TARGET,
      POOL_SWAP_FEE_PERCENTAGE,
      wrappedTokenRateProvider,
      WRAPPED_TOKEN_RATE_CACHE_DURATION,
      owner.address
    );

    const event = expectEvent.inReceipt(await receipt.wait(), 'PoolCreated');
    return deployedAt('LinearPool', event.args.pool);
  }

  describe('constructor arguments', () => {
    let pool: Contract;

    sharedBeforeEach('create pool', async () => {
      pool = await createPool();
    });

    it('sets the vault', async () => {
      expect(await pool.getVault()).to.equal(vault.address);
    });

    it('registers tokens in the vault', async () => {
      const poolId = await pool.getPoolId();
      const poolTokens = await vault.getPoolTokens(poolId);

      expect(poolTokens.tokens).to.have.lengthOf(3);
      expect(poolTokens.tokens).to.include(tokens.DAI.address);
      expect(poolTokens.tokens).to.include(tokens.CDAI.address);
      expect(poolTokens.tokens).to.include(pool.address);

      poolTokens.tokens.forEach((token, i) => {
        expect(poolTokens.balances[i]).to.be.eq(token === pool.address ? MAX_UINT112 : 0);
      });
    });

    it('starts with all the BPT minted', async () => {
      expect(await pool.totalSupply()).to.be.equal(MAX_UINT112);
    });

    it('sets no asset managers', async () => {
      const poolId = await pool.getPoolId();
      await tokens.asyncEach(async (token) => {
        const info = await vault.getPoolTokenInfo(poolId, token);
        expect(info.assetManager).to.equal(ZERO_ADDRESS);
      });
    });

    it('sets swap fee', async () => {
      expect(await pool.getSwapFeePercentage()).to.equal(POOL_SWAP_FEE_PERCENTAGE);
    });

    it('sets the owner ', async () => {
      expect(await pool.getOwner()).to.equal(owner.address);
    });

    it('sets the name', async () => {
      expect(await pool.name()).to.equal(NAME);
    });

    it('sets the symbol', async () => {
      expect(await pool.symbol()).to.equal(SYMBOL);
    });

    it('sets the decimals', async () => {
      expect(await pool.decimals()).to.equal(18);
    });

    it('sets main token', async () => {
      expect(await pool.getMainToken()).to.equal(tokens.DAI.address);
    });

    it('sets wrapped token', async () => {
      expect(await pool.getWrappedToken()).to.equal(tokens.CDAI.address);
    });

    it('sets the targets', async () => {
      const targets = await pool.getTargets();
      expect(targets.lowerTarget).to.be.equal(LOWER_TARGET);
      expect(targets.upperTarget).to.be.equal(UPPER_TARGET);
    });

    it('sets the wrapped token rate provider', async () => {
      const provider = await pool.getWrappedTokenRateProvider();
      expect(provider).to.be.equal(wrappedTokenRateProvider);
    });

    it('initializes the wrapped token rate cache', async () => {
      const { expires, duration, rate } = await pool.getWrappedTokenRateCache();
      expect(rate).to.equal(fp(1));
      expect(duration).to.equal(WRAPPED_TOKEN_RATE_CACHE_DURATION);
      expect(expires).to.be.at.least(creationTime.add(WRAPPED_TOKEN_RATE_CACHE_DURATION));
    });
  });

  describe('temporarily pausable', () => {
    it('pools have the correct window end times', async () => {
      const pool = await createPool();
      const { pauseWindowEndTime, bufferPeriodEndTime } = await pool.getPausedState();

      expect(pauseWindowEndTime).to.equal(creationTime.add(BASE_PAUSE_WINDOW_DURATION));
      expect(bufferPeriodEndTime).to.equal(creationTime.add(BASE_PAUSE_WINDOW_DURATION + BASE_BUFFER_PERIOD_DURATION));
    });

    it('multiple pools have the same window end times', async () => {
      const firstPool = await createPool();
      await advanceTime(BASE_PAUSE_WINDOW_DURATION / 3);
      const secondPool = await createPool();

      const { firstPauseWindowEndTime, firstBufferPeriodEndTime } = await firstPool.getPausedState();
      const { secondPauseWindowEndTime, secondBufferPeriodEndTime } = await secondPool.getPausedState();

      expect(firstPauseWindowEndTime).to.equal(secondPauseWindowEndTime);
      expect(firstBufferPeriodEndTime).to.equal(secondBufferPeriodEndTime);
    });

    it('pools created after the pause window end date have no buffer period', async () => {
      await advanceTime(BASE_PAUSE_WINDOW_DURATION + 1);

      const pool = await createPool();
      const { pauseWindowEndTime, bufferPeriodEndTime } = await pool.getPausedState();
      const now = await currentTimestamp();

      expect(pauseWindowEndTime).to.equal(now);
      expect(bufferPeriodEndTime).to.equal(now);
    });
  });
});
