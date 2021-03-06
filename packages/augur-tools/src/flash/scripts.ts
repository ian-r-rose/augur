import { FlashSession, FlashArguments } from './flash';
import { createCannedMarkets } from './create-canned-markets-and-orders';
import { _1_ETH, BASE_MNEMONIC } from '../constants';
import {
  Contracts as compilerOutput,
  refreshSDKConfig,
  abiV1,
  environments,
  buildConfig,
  printConfig,
} from '@augurproject/artifacts';
import { ContractInterfaces } from '@augurproject/core';
import moment from 'moment';
import { BigNumber } from 'bignumber.js';
import { formatBytes32String } from 'ethers/utils';
import { ethers } from 'ethers';
import {
  QUINTILLION,
  convertDisplayAmountToOnChainAmount,
  convertDisplayPriceToOnChainPrice,
  stringTo32ByteHex,
  numTicksToTickSizeWithDisplayPrices,
  convertOnChainPriceToDisplayPrice,
  NativePlaceTradeDisplayParams,
  startServer,
} from '@augurproject/sdk';
import { fork } from './fork';
import { dispute } from './dispute';
import {
  MarketList,
  MarketOrderBook
} from '@augurproject/sdk/build/state/getter/Markets';
import { generateTemplateValidations } from './generate-templates';
import { spawn, spawnSync } from 'child_process';
import { showTemplateByHash, validateMarketTemplate } from './template-utils';
import { cannedMarkets, singleOutcomeAsks, singleOutcomeBids } from './data/canned-markets';
import { ContractAPI, deployContracts } from '..';
import { OrderBookShaper } from './orderbook-shaper';
import { NumOutcomes } from '@augurproject/sdk/src/state/logs/types';
import { flattenZeroXOrders } from '@augurproject/sdk/build/state/getter/ZeroXOrdersGetters';
import { formatAddress, sleep, waitForSigint, waitForSync } from './util';
import { runWsServer, runWssServer } from '@augurproject/sdk/build/state/WebsocketEndpoint';
import { createApp, runHttpServer, runHttpsServer } from '@augurproject/sdk/build/state/HTTPEndpoint';
import { orderFirehose } from './order-firehose';
import { Market } from '@augurproject/core/build/libraries/ContractInterfaces';
import {
  AccountCreator,
  createOrders,
  FINNEY,
  getAllMarkets,
  setupMarkets,
  setupOrderBookShapers,
  setupOrders,
  setupPerfConfigAndZeroX,
  setupUsers,
  takeOrder,
  takeOrders
} from './performance';

export function addScripts(flash: FlashSession) {
  flash.addScript({
    name: 'connect',
    description: 'Connect to an Ethereum node.',
    options: [
      {
        name: 'account',
        abbr: 'a',
        description:
          'account address to connect with, if no address provided contract owner is used',
      },
      {
        name: 'network',
        abbr: 'n',
        description:
          'Which network to connect to. Defaults to "local" aka local node.',
      },
      {
        name: 'useSdk',
        abbr: 'u',
        description: 'a few scripts need sdk, -u to wire up sdk',
        flag: true,
      },
      {
        name: 'useZeroX',
        abbr: 'z',
        description: 'use zeroX mesh client endpoint',
        flag: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const network = (args.network as string) || 'local';
      const account = args.account as string;
      const useSdk = Boolean(args.useSdk);
      const useZeroX = Boolean(args.useZeroX);
      if (account) flash.account = account;
      this.config = environments[network];
      this.provider = this.makeProvider(this.config);
      await this.ensureUser(this.network, useSdk, true, null, useZeroX, useZeroX);
    },
  });

  flash.addScript({
    name: 'show-config',
    async call(this: FlashSession) {
      printConfig(this.config);
    }
  });

  flash.addScript({
    name: 'deploy',
    description:
      'Upload contracts to blockchain and register them with the Augur contract.',
    options: [
      {
        name: 'write-artifacts',
        abbr: 'w',
        description: 'Deprecated. Kept for compatibility.',
        flag: true,
      },
      {
        name: 'do-not-write-artifacts',
        description: 'Prevents deploy from overwriting environments/$env.json',
        flag: true,
      },
      {
        name: 'time-controlled',
        abbr: 't',
        description:
          'Use the TimeControlled contract for testing environments.',
        flag: true,
      },
      {
        name: 'useSdk',
        abbr: 'u',
        description: 'a few scripts need sdk, -u to wire up sdk',
        flag: true,
      },
      {
        name: 'environment',
        abbr: 'e',
        description: 'name of environment. ex: local, kovan, mainnet'
      },
      {
        name: 'parallel',
        abbr: 'p',
        description: 'deploy contracts non-serially',
        flag: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const useSdk = Boolean(args.useSdk);
      const serial = !Boolean(args.parallel);
      const env = args.environment as string || this.network || 'local';
      if (this.noProvider()) return;

      console.log('Deploying: ', args);

      if (typeof args.doNotWriteArtifacts !== 'undefined') {
        this.config.deploy.writeArtifacts = !Boolean(args.doNotWriteArtifacts)
      }
      if (typeof args.timeControlled !== 'undefined') {
        this.config.deploy.normalTime = !Boolean(args.timeControlled)
      }

      const { addresses } = await deployContracts(
        env,
        this.provider,
        this.accounts[0],
        compilerOutput,
        this.config,
        serial
      );
      this.config.addresses = addresses;

      if (useSdk) {
        await flash.ensureUser(this.network, useSdk);
      }
    },
  });

  flash.addScript({
    name: 'faucet',
    description: 'Mints Cash tokens for user.',
    options: [
      {
        name: 'amount',
        abbr: 'a',
        description: 'Quantity of Cash.',
        required: true,
      },
      {
        name: 'target',
        abbr: 't',
        description: 'Account to send funds (defaults to current user)',
        required: false
      },
      {
        name: 'use-gsn',
        abbr: 'g',
        description: 'Faucet via gsn',
        flag: true,
        required: false
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const target = args.target as string;
      const useGsn = Boolean(args.useGsn);
      const amount = Number(args.amount);
      const atto = new BigNumber(amount).times(_1_ETH);

      if (this.noProvider()) return;
      const user = await this.ensureUser(undefined, null, true, null, null, useGsn);

      await user.faucetOnce(atto);

      // If we have a target we transfer from current account to target.
      // Cannot directly faucet to target because:
      // 1) it might not have ETH, and
      // 2) specifying sender for contract calls only works if signer is available,
      //    which is typically only true of main account or its wallet
      if (target) {
        await user.augur.contracts.cash.transfer(target, atto);
      }
    },
  });

  flash.addScript({
    name: 'transfer',
    description: 'Transfer tokens to account',
    options: [
      {
        name: 'amount',
        abbr: 'a',
        description: 'Quantity',
        required: true,
      },
      {
        name: 'token',
        abbr: 'k',
        description: 'REP, ETH, DAI',
        required: true,
      },
      {
        name: 'target',
        abbr: 't',
        description: 'Account to send funds (defaults to current user)',
        required: false
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.ensureUser();

      const target = String(args.target);
      const amount = Number(args.amount);
      const token = String(args.token);
      const atto = new BigNumber(amount).times(_1_ETH);

      switch(token) {
        case 'REP':
          return user.augur.contracts.getReputationToken().transfer(target, atto);
        case 'ETH':
          return user.augur.sendETH(target, atto);
        default:
          return user.augur.contracts.cash.transfer(target, atto);
      }
    },
  });

  flash.addScript({
    name: 'rep-faucet',
    description: 'Mints REP tokens for user.',
    options: [
      {
        name: 'amount',
        abbr: 'a',
        description: 'Quantity of REP.',
        required: true,
      },
      {
        name: 'target',
        abbr: 't',
        description: 'Account to send funds (defaults to current user)',
        required: false
      },
      {
        name: 'useLegacyRep',
        abbr: 'r',
        flag: true,
        description: 'faucet legacy rep',
        required: false
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const useLegacyRep = Boolean(args.useLegacyRep);
      const user = await this.ensureUser();
      const amount = Number(args.amount);
      const atto = new BigNumber(amount).times(_1_ETH);

      await user.repFaucet(atto, useLegacyRep);

      // if we have a target we transfer from current account to target.
      if(args.target) {
        if (useLegacyRep) {
          await user.augur.contracts.legacyReputationToken.transfer(String(args.target), atto);
        } else {
          await user.augur.contracts.reputationToken.transfer(String(args.target), atto);
        }
      }
    },
  });

  flash.addScript({
    name: 'migrate-rep',
    description: 'migrate rep to universe.',
    options: [
      {
        name: 'payoutNumerators',
        abbr: 'p',
        description: 'payout numerators of child unverse.',
        required: true,
      },
      {
        name: 'amount',
        abbr: 'a',
        description: 'Quantity of REP.',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.ensureUser();
      const amount = Number(args.amount);
      const atto = new BigNumber(amount).times(_1_ETH);
      const payout = String(args.payoutNumerators)
        .split(',')
        .map(i => new BigNumber(i));
      console.log(payout);
      await user.migrateOutByPayoutNumerators(payout, atto);
    },
  });

  flash.addScript({
    name: 'gas-limit',
    async call(this: FlashSession): Promise<number | undefined> {
      if (this.noProvider()) return undefined;

      const block = await this.provider.getBlock('latest');
      const gasLimit = block.gasLimit.toNumber();
      this.log(`Gas limit: ${gasLimit}`);
      return gasLimit;
    },
  });

  flash.addScript({
    name: 'latest-block',
    async call(this: FlashSession): Promise<void> {
      if (this.noProvider()) return undefined;

      const block = await this.provider.getBlock('latest');
      this.log(JSON.stringify(block, null, 2));
    }
  });

  flash.addScript({
    name: 'new-market',
    options: [
      {
        name: 'yesno',
        abbr: 'y',
        description: 'create yes no market, default if no options are added',
        flag: true,
      },
      {
        name: 'categorical',
        abbr: 'c',
        description: 'create categorical market',
        flag: true,
      },
      {
        name: 'scalar',
        abbr: 's',
        description: 'create scalar market',
        flag: true,
      },
      {
        name: 'title',
        abbr: 'd',
        description: 'market title',
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const yesno = args.yesno as boolean;
      const cat = args.categorical as boolean;
      const scalar = args.scalar as boolean;
      const title = args.title ? String(args.title) : null;
      if (yesno) {
        await this.call('create-reasonable-yes-no-market', {title});
      }
      if (cat) {
        await this.call('create-reasonable-categorical-market', {outcomes: 'first,second,third,fourth,fifth'});
      }
      if (scalar) {
        await this.call('create-reasonable-scalar-market', {title});
      }

      if (!yesno && !cat && !scalar) {
        await this.call('create-reasonable-yes-no-market', {title});
      }
    }
  });

  flash.addScript({
    name: 'create-reasonable-yes-no-market',
    options: [
      {
        name: 'title',
        abbr: 'd',
        description: 'market title',
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const title = args.title ? String(args.title) : null;
      if (this.noProvider()) return;
      const user = await this.ensureUser();

      this.market = await user.createReasonableYesNoMarket(title);
      this.log(`Created YesNo market "${this.market.address}".`);
      return this.market;
    },
  });

  flash.addScript({
    name: 'create-reasonable-categorical-market',
    options: [
      {
        name: 'outcomes',
        abbr: 'o',
        description: 'Comma-separated.',
        required: true,
      },
      {
        name: 'title',
        abbr: 'd',
        description: 'market title',
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.ensureUser();
      const outcomes: string[] = (args.outcomes as string)
        .split(',')
        .map(formatBytes32String);
      const title = args.title ? String(args.title) : null;
      this.market = await user.createReasonableMarket(outcomes, title);
      this.log(`Created Categorical market "${this.market.address}".`);
      return this.market;
    },
  });

  flash.addScript({
    name: 'create-reasonable-scalar-market',
    options: [
      {
        name: 'title',
        abbr: 'd',
        description: 'market title',
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.ensureUser();
      const title = args.title ? String(args.title) : null;
      this.market = await user.createReasonableScalarMarket(title);
      this.log(`Created Scalar market "${this.market.address}".`);
      return this.market;
    },
  });

  flash.addScript({
    name: 'create-canned-markets',
    options: [
      {
        name: 'use-gsn',
        abbr: 'g',
        description: 'Faucet via gsn',
        flag: true,
        required: false
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const useGsn = Boolean(args.useGsn);
      const user = await this.ensureUser(undefined, null, true, null, null, useGsn);
      await user.repFaucet(QUINTILLION.multipliedBy(1000000));
      await user.faucetOnce(QUINTILLION.multipliedBy(1000000));
      await user.approve(QUINTILLION.multipliedBy(3000000));

      await this.call('init-warp-sync', {});
      await this.call('add-eth-exchange-liquidity', {
        ethAmount: '4',
        cashAmount: '600'
      });
      return createCannedMarkets(user);
    },
  });

  flash.addScript({
    name: 'create-canned-markets-with-orders',
    async call(this: FlashSession) {
      await this.ensureUser();
      const markets = await this.call('create-canned-markets', {});
      for(let i = 0; i < markets.length; i++) {
        const createdMarket = markets[i];
        const numTicks = await createdMarket.market.getNumTicks_();
        const numOutcomes = await createdMarket.market.getNumberOfOutcomes_();
        const marketId = createdMarket.market.address;
        const skipFaucetOrApproval = true;
        if(numOutcomes.gt(new BigNumber(3))) {
          await this.call('create-cat-zerox-orders', {marketId, numOutcomes: numOutcomes.toString(), skipFaucetOrApproval});
        } else {
          if (numTicks.eq(new BigNumber(100))) {
            await this.call('create-yesno-zerox-orders', {marketId, skipFaucetOrApproval});
          } else {
            try {
              const maxPrice = createdMarket.canned.maxPrice;
              const minPrice = createdMarket.canned.minPrice;
              await this.call('create-scalar-zerox-orders', {marketId, maxPrice, minPrice, numTicks: numTicks.toString(), skipFaucetOrApproval});
            } catch(e) {
              console.log('could not create orders for scalar market', e)
            }
          }
        }
      }
    },
  });

  flash.addScript({
    name: 'create-yesno-zerox-orders',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description: 'market to create zeroX orders on',
      },
      {
        name: 'skipFaucetOrApproval',
        flag: true,
        description: 'do not faucet or approve, has already been done'
      },
      {
        name: 'network',
        abbr: 'n',
        description:
          'Which network to connect to. Defaults to "environment" aka local node.',
      },
      {
        name: 'useGsn',
        flag: true,
        description: 'use wallet instead of user account'
      },
      {
        name: 'userAccount',
        abbr: 'u',
        description:
          'User account to create orders, if not provided then contract owner is used',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const market = String(args.marketId);
      const useGsn = Boolean(args.useGsn);
      const address = args.userAccount ? (args.userAccount as string) : null;
      const user = await this.ensureUser(this.network, false, true, address, true, useGsn);
      const skipFaucetApproval = Boolean(args.skipFaucetOrApproval);
      if (!skipFaucetApproval) {
        await user.faucetOnce(QUINTILLION.multipliedBy(1000000));
        await user.approve(QUINTILLION.multipliedBy(1000000));
      }
      const yesNoMarket = cannedMarkets.find(c => c.marketType === 'yesNo');
      const orderBook = yesNoMarket.orderBook;
      const timestamp = await this.call('get-timestamp', {});
      const tradeGroupId = String(Date.now());
      const oneHundredDays = new BigNumber(8640000);
      const expirationTime = new BigNumber(timestamp).plus(oneHundredDays);
      const orders = [];
      for (let a = 0; a < Object.keys(orderBook).length; a++) {
        const outcome = Number(Object.keys(orderBook)[a]) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
        const buySell = Object.values(orderBook)[a];

        const { buy, sell } = buySell;

        for (const { shares, price } of buy) {
          this.log(`creating buy order, ${shares} @ ${price}`);
          orders.push({
            direction: 0,
            market,
            numTicks: new BigNumber(100),
            numOutcomes: 3,
            outcome,
            tradeGroupId,
            fingerprint: formatBytes32String('11'),
            doNotCreateOrders: false,
            displayMinPrice: new BigNumber(0),
            displayMaxPrice: new BigNumber(1),
            displayAmount: new BigNumber(shares),
            displayPrice: new BigNumber(price),
            displayShares: new BigNumber(0),
            expirationTime,
          });
        }

        for (const { shares, price } of sell) {
          this.log(`creating sell order, ${shares} @ ${price}`);
          orders.push({
            direction: 1,
            market,
            numTicks: new BigNumber(100),
            numOutcomes: 3,
            outcome,
            tradeGroupId,
            fingerprint: formatBytes32String('11'),
            doNotCreateOrders: false,
            displayMinPrice: new BigNumber(0),
            displayMaxPrice: new BigNumber(1),
            displayAmount: new BigNumber(shares),
            displayPrice: new BigNumber(price),
            displayShares: new BigNumber(0),
            expirationTime,
          });
        }
      }
      await user.placeZeroXOrders(orders).catch(e => console.log(e));
    },
  });

  flash.addScript({
    name: 'create-cat-zerox-orders',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        required: true,
        description: 'market to create zeroX orders on',
      },
      {
        name: 'numOutcomes',
        abbr: 'o',
        required: true,
        description: 'number of outcomes the market has',
      },
      {
        name: 'skipFaucetOrApproval',
        flag: true,
        description: 'do not faucet or approve, has already been done'
      },
      {
        name: 'network',
        abbr: 'n',
        description:
          'Which network to connect to. Defaults to "environment" aka local node.',
      },
      {
        name: 'useGsn',
        flag: true,
        description: 'use wallet instead of user account'
      },
      {
        name: 'userAccount',
        abbr: 'u',
        description:
          'User account to create orders, if not provided then contract owner is used',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const market = String(args.marketId);
      const numOutcomes = Number(args.numOutcomes);
      const useGsn = Boolean(args.useGsn);
      const address = args.userAccount ? (args.userAccount as string) : null;
      const user = await this.ensureUser(this.network, false, true, address, true, useGsn);
      const skipFaucetApproval = Boolean(args.skipFaucetOrApproval);
      if (!skipFaucetApproval) {
        await user.faucetOnce(QUINTILLION.multipliedBy(1000000));
        await user.approve(QUINTILLION.multipliedBy(1000000));
      }

      const orderBook = {
        1: {
          buy: singleOutcomeBids,
          sell: singleOutcomeAsks,
        },
        2: {
          buy: singleOutcomeBids,
          sell: singleOutcomeAsks,
        },
        3: {
          buy: singleOutcomeBids,
          sell: singleOutcomeAsks,
        },
        4: {
          buy: singleOutcomeBids,
          sell: singleOutcomeAsks,
        },
        5: {
          buy: singleOutcomeBids,
          sell: singleOutcomeAsks,
        },
        6: {
          buy: singleOutcomeBids,
          sell: singleOutcomeAsks,
        },
        7: {
          buy: singleOutcomeBids,
          sell: singleOutcomeAsks,
        },
      };

      const timestamp = await this.call('get-timestamp', {});
      const tradeGroupId = String(Date.now());
      const oneHundredDays = new BigNumber(8640000);
      const expirationTime = new BigNumber(timestamp).plus(oneHundredDays);
      const orders = [];
      for (let a = 0; a < numOutcomes; a++) {
        const outcome = Number(Object.keys(orderBook)[a]) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
        const buySell = Object.values(orderBook)[a];

        const { buy, sell } = buySell;

        for (const { shares, price } of buy) {
          this.log(`creating buy order, ${shares} @ ${price}`);
          orders.push({
            direction: 0,
            market,
            numTicks: new BigNumber(100),
            numOutcomes: 3,
            outcome,
            tradeGroupId,
            fingerprint: formatBytes32String('11'),
            doNotCreateOrders: false,
            displayMinPrice: new BigNumber(0),
            displayMaxPrice: new BigNumber(1),
            displayAmount: new BigNumber(shares),
            displayPrice: new BigNumber(price),
            displayShares: new BigNumber(0),
            expirationTime,
          });
        }

        for (const { shares, price } of sell) {
          this.log(`creating sell order, ${shares} @ ${price}`);
          orders.push({
            direction: 1,
            market,
            numTicks: new BigNumber(100),
            numOutcomes: 3,
            outcome,
            tradeGroupId,
            fingerprint: formatBytes32String('11'),
            doNotCreateOrders: false,
            displayMinPrice: new BigNumber(0),
            displayMaxPrice: new BigNumber(1),
            displayAmount: new BigNumber(shares),
            displayPrice: new BigNumber(price),
            displayShares: new BigNumber(0),
            expirationTime,
          });
        }
      }
      await user.placeZeroXOrders(orders).catch(e => console.log(e));
    },
  });

  flash.addScript({
    name: 'create-scalar-zerox-orders',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        required: true,
        description: 'market to create zeroX orders on',
      },
      {
        name: 'maxPrice',
        abbr: 'x',
        required: true,
        description: 'max price',
      },
      {
        name: 'minPrice',
        abbr: 'p',
        required: true,
        description: 'min price',
      },
      {
        name: 'numTicks',
        abbr: 't',
        required: true,
        description: 'market numTicks',
      },
      {
        name: 'onInvalid',
        flag: true,
        description: 'create zeroX orders on invalid outcome',
      },
      {
        name: 'skipFaucetOrApproval',
        flag: true,
        description: 'do not faucet or approve, has already been done'
      },
      {
        name: 'network',
        abbr: 'n',
        description:
          'Which network to connect to. Defaults to "environment" aka local node.',
      },
      {
        name: 'useGsn',
        flag: true,
        description: 'use wallet instead of user account'
      },
      {
        name: 'userAccount',
        abbr: 'u',
        description:
          'User account to create orders, if not provided then contract owner is used',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const market = String(args.marketId);
      const useGsn = Boolean(args.useGsn);
      const address = args.userAccount ? (args.userAccount as string) : null;
      const user = await this.ensureUser(this.network, false, true, address, true, useGsn);
      const skipFaucetApproval = Boolean(args.skipFaucetOrApproval);
      if (!skipFaucetApproval) {
        await user.faucetOnce(QUINTILLION.multipliedBy(1000000));
        await user.approve(QUINTILLION.multipliedBy(1000000));
      }

      const timestamp = await this.call('get-timestamp', {});
      const tradeGroupId = String(Date.now());
      const oneHundredDays = new BigNumber(8640000);
      const onInvalid = args.onInvalid as boolean;
      const numTicks = new BigNumber(String(args.numTicks));
      const maxPrice = new BigNumber(String(args.maxPrice));
      const minPrice = new BigNumber(String(args.minPrice));
      const tickSize = numTicksToTickSizeWithDisplayPrices(numTicks, minPrice, maxPrice);
      const midPrice = maxPrice.minus((numTicks.dividedBy(2)).times(tickSize));

      const orderBook = {
        2: {
          buy: [
              { shares: '30', price: midPrice.plus(tickSize.times(3)) },
              { shares: '20', price: midPrice.plus(tickSize.times(2)) },
              { shares: '10', price: midPrice.plus(tickSize) },
          ],
          sell: [
              { shares: '10', price: midPrice.minus(tickSize) },
              { shares: '20', price: midPrice.minus(tickSize.times(2)) },
              { shares: '30', price: midPrice.minus(tickSize.times(3)) },
          ],
        },
      };
      const expirationTime = new BigNumber(timestamp).plus(oneHundredDays);
      const orders = [];
      for (let a = 0; a < Object.keys(orderBook).length; a++) {
        const outcome = !onInvalid ? Number(Object.keys(orderBook)[a]) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 : 0;
        const buySell = Object.values(orderBook)[a];

        const { buy, sell } = buySell;

        for (const { shares, price } of buy) {
          this.log(`creating buy order, ${shares} @ ${price}`);
          const order = {
            direction: 0 as 0 | 1,
            market,
            numTicks,
            numOutcomes: 3 as 3 | 4 | 5 | 6 | 7,
            outcome,
            tradeGroupId,
            fingerprint: formatBytes32String('11'),
            doNotCreateOrders: false,
            displayMinPrice: minPrice,
            displayMaxPrice: maxPrice,
            displayAmount: new BigNumber(shares),
            displayPrice: new BigNumber(price),
            displayShares: new BigNumber(0),
            expirationTime,
          };
          console.log(JSON.stringify(order));
          orders.push(order);
        }

        for (const { shares, price } of sell) {
          this.log(`creating sell order, ${shares} @ ${price}`);
          const order = {
            direction: 1 as 0 | 1,
            market,
            numTicks,
            numOutcomes: 3 as 3 | 4 | 5 | 6 | 7,
            outcome,
            tradeGroupId,
            fingerprint: formatBytes32String('11'),
            doNotCreateOrders: false,
            displayMinPrice: minPrice,
            displayMaxPrice: maxPrice,
            displayAmount: new BigNumber(shares),
            displayPrice: new BigNumber(price),
            displayShares: new BigNumber(0),
            expirationTime,
          };
          console.log(JSON.stringify(order));
          orders.push(order);
        }
      }
      await user.placeZeroXOrders(orders);
    },
  });

  flash.addScript({
    name: 'get-market-order-book',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description: 'Show orders that have been placed on the book of this marketId'
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const user: ContractAPI = await this.ensureUser(this.network, true, true, null, true, true);
      await new Promise<void>(resolve => setTimeout(resolve, 90000));
      const result = await user.augur.getMarketOrderBook({ marketId: String(args.marketId)});
      this.log(JSON.stringify(result));
      return result;
    }
  });

  flash.addScript({
    name: 'create-markets-orderbook-shaper',
    options: [
      {
        name: 'numMarkets',
        abbr: 'm',
        description: 'number of markets to create and have orderbook maintain, default is 10'
      },
      {
        name: 'userAccount',
        abbr: 'u',
        description: 'User account to create orders, if not provider contract owner is used'
      },
      {
        name: 'network',
        abbr: 'n',
        description:
          'Which network to connect to. Defaults to "environment" aka local node.',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const numMarkets = args.numMarkets ? Number(args.numMarkets) : 10;
      const userAccount = args.userAccount ? args.userAccount as string : null;
      const user: ContractAPI = await this.ensureUser(this.network, true, true, userAccount, true, true);
      const timestamp = await user.getTimestamp();
      const ids: string[] = [];
      for(let i = 0; i < numMarkets; i++) {
        const title = `YesNo market: ${timestamp} Number ${i} with orderbook mgr`;
        const market: ContractInterfaces.Market = await user.createReasonableYesNoMarket(title);
        ids.push(market.address);
      }
      const marketIds = ids.join(',');
      await this.call('simple-orderbook-shaper', {marketIds, userAccount});
    }
  });

  flash.addScript({
    name: 'simple-orderbook-shaper',
    options: [
      {
        name: 'marketIds',
        abbr: 'm',
        description:
          'Market ids separated by commas for multiple to create orders and maintain order book, ie 0x122,0x333,0x4444',
      },
      {
        name: 'userAccount',
        abbr: 'u',
        description:
          'User account to create orders, if not provided then contract owner is used',
      },
      {
        name: 'network',
        abbr: 'n',
        description:
          'Which network to connect to. Defaults to "environment" aka local node.',
      },
      {
        name: 'refreshInterval',
        abbr: 'r',
        required: false,
        description: 'refresh interval in seconds, time to wait before checking market orderbook. default 15 seconds',
      },
      {
        name: 'orderSize',
        abbr: 's',
        required: false,
        description: 'quantity used when orders need to be created. default is one large chunk, possible values are 10, 100, ...',
      },
      {
        name: 'expiration',
        abbr: 'x',
        required: false,
        description: 'number of added seconds to order will live, default is ten minutes',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const marketIds = String(args.marketIds)
        .split(',')
        .map(id => id.trim());
      const address = args.userAccount ? (args.userAccount as string) : null;
      const interval = args.refreshInterval ? Number(args.refreshInterval) * 1000 : 15000;
      const orderSize = args.orderSize ? Number(args.orderSize) : null;
      const expiration = args.expiration ? new BigNumber(String(args.expiration)) : new BigNumber(600);
      const user: ContractAPI = await this.ensureUser(this.network, true, true, address, true, true);
      console.log('waiting many seconds on purpose for client to sync');
      await new Promise<void>(resolve => setTimeout(resolve, 90000));

      const orderBooks = marketIds.map(m => new OrderBookShaper(m, orderSize, expiration));
      while (true) {
        const timestamp = await this.user.getTimestamp();
        for (let i = 0; i < orderBooks.length; i++) {
          const orderBook: OrderBookShaper = orderBooks[i];
          const marketId = orderBook.marketId;
          const marketBook: MarketOrderBook = await this.user.augur.getMarketOrderBook(
            { marketId }
          );
          const orders = orderBook.nextRun(marketBook.orderBook, new BigNumber(timestamp));
          if (orders.length > 0) {
            this.log(`creating ${orders.length} orders for ${marketId}`);
            orders.map(order => console.log(`Creating ${order.displayAmount} at ${order.displayPrice} on outcome ${order.outcome}`));
            await user.placeZeroXOrders(orders).catch(this.log);
          }
        }
        await new Promise<void>(resolve => setTimeout(resolve, interval));
      }

    },
  });

  flash.addScript({
    name: 'order-firehose',
    options: [
      {
        name: 'marketIds',
        abbr: 'm',
        description:
          'Market ids separated by commas for multiple to create orders and maintain order book, ie 0x122,0x333,0x4444',
      },
      {
        name: 'userAccount',
        abbr: 'u',
        description:
          'User account to create orders, if not provided then contract owner is used',
      },
      {
        name: 'network',
        abbr: 'n',
        description:
          'Which network to connect to. Defaults to "environment" aka local node.',
      },
      {
        name: 'numOrderLimit',
        abbr: 'l',
        required: false,
        description: 'number of orders to create at a time, default is 100',
      },
      {
        name: 'delayBetweenBursts',
        abbr: 'd',
        required: false,
        description: 'seconds to wait between each order burst, default is 1 second',
      },
      {
        name: 'burstRounds',
        abbr: 'r',
        required: false,
        description: 'number of order burst rounds, default is 10',
      },
      {
        name: 'expiration',
        abbr: 'x',
        required: false,
        description: 'number of added seconds to order will live, default is ten minutes',
      },
      {
        name: 'orderSize',
        abbr: 's',
        required: false,
        description: 'quantity used on created order, default is 10',
      },
      {
        name: 'outcomes',
        abbr: 'o',
        required: false,
        description: 'outcomes to put orders on, default is 2,1',
      },
      {
        name: 'useGsn',
        flag: true,
        description: 'use wallet instead of user account'
      },
      {
        name: 'skipFaucetOrApproval',
        flag: true,
        description: 'do not faucet or approve, has already been done'
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const marketIds = String(args.marketIds)
        .split(',')
        .map(id => id.trim());
      const orderOutcomes: number[] = (args.outcomes ? String(args.outcomes) : '2,1')
        .split(',')
        .map(id => Number(id.trim()));
      const address = args.userAccount ? (args.userAccount as string) : null;
      const delayBetweenBursts = args.delayBetweenBursts ? Number(args.delayBetweenBursts) : 1;
      const numOrderLimit = args.numOrderLimit ? Number(args.numOrderLimit) : 100;
      const burstRounds = args.burstRounds ? Number(args.burstRounds) : 10;
      const orderSize = args.orderSize ? Number(args.orderSize) : 10;
      const expiration = args.expiration ? new BigNumber(String(args.expiration)) : new BigNumber(600); // ten minutes
      const useGsn = Boolean(args.useGsn);
      const skipFaucetOrApproval = Boolean(args.skipFaucetOrApproval);
      const user: ContractAPI = await this.ensureUser(this.network, false, true, address, true, useGsn);

      await orderFirehose(
        marketIds,
        orderOutcomes,
        delayBetweenBursts,
        numOrderLimit,
        burstRounds,
        orderSize,
        expiration,
        skipFaucetOrApproval,
        [user]);
    },
  });

  flash.addScript({
    name: 'create-market-order',
    options: [
      {
        name: 'userAccount',
        abbr: 'u',
        description: 'user account to create the order',
      },
      {
        name: 'marketId',
        abbr: 'm',
        description:
          'ASSUMES: binary or categorical markets, market id to place the order',
      },
      {
        name: 'outcome',
        abbr: 'o',
        description: 'outcome to place the order',
      },
      {
        name: 'orderType',
        abbr: 't',
        description: 'order type of the order [bid], [ask]',
      },
      {
        name: 'amount',
        abbr: 'a',
        description: 'number of shares in the order',
      },
      {
        name: 'price',
        abbr: 'p',
        description: 'price of the order',
      },
      {
        name: 'fillOrder',
        abbr: 'f',
        flag: true,
        required: false,
        description: 'fill order'
      },
      {
        name: 'skipFaucetOrApproval',
        abbr: 'k',
        flag: true,
        description: 'do not faucet or approve, has already been done'
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const address = args.userAccount as string;
      const isZeroX = args.zerox as boolean;
      const fillOrder = args.fillOrder as boolean;
      let user: ContractAPI = null;

      if (isZeroX) {
        user = await this.ensureUser(this.network, true, true, address, true, true);
      } else {
        user = await this.ensureUser(null, true, true, address);
      }
      const skipFaucetOrApproval = Boolean(args.skipFaucetOrApproval);
      if (!skipFaucetOrApproval) {
        this.log('create-market-order, faucet and approval');
        await user.faucetOnce(QUINTILLION.multipliedBy(10000));
        await user.approve(QUINTILLION.multipliedBy(100000));
      }
      const orderType = String(args.orderType).toLowerCase();
      const type = orderType === 'bid' || orderType === 'buy' ? 0 : 1;

      const onChainShares = convertDisplayAmountToOnChainAmount(
        new BigNumber(String(args.amount)),
        new BigNumber(100)
      );
      const onChainPrice = convertDisplayPriceToOnChainPrice(
        new BigNumber(String(Number(args.price).toFixed(2))),
        new BigNumber(0),
        new BigNumber('0.01')
      );
      const nullOrderId = stringTo32ByteHex('');
      const tradeGroupId = stringTo32ByteHex('tradegroupId');
      let result = null;
      if (isZeroX) {
        const timestamp = await this.call('get-timestamp', {});
        const oneHundredDays = new BigNumber(8640000);
        const expirationTime = new BigNumber(timestamp).plus(oneHundredDays);
        const onChainPrice = convertDisplayPriceToOnChainPrice(
          new BigNumber(String(Number(args.price).toFixed(2))),
          new BigNumber(0),
          new BigNumber('0.01')
        );
        const price = convertOnChainPriceToDisplayPrice(
          onChainPrice,
          new BigNumber(0),
          new BigNumber('0.01')
        );
        const params = {
          direction: type as 0 | 1,
          market : String(args.marketId),
          numTicks: new BigNumber(100),
          numOutcomes: 3 as NumOutcomes,
          outcome: Number(args.outcome) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
          tradeGroupId,
          fingerprint: formatBytes32String('11'),
          doNotCreateOrders: false,
          displayMinPrice: new BigNumber(0),
          displayMaxPrice: new BigNumber(1),
          displayAmount: new BigNumber(String(args.amount)),
          displayPrice: price,
          displayShares: new BigNumber(0),
          expirationTime,
        };

        try {
          result = fillOrder ? await user.augur.placeTrade(params) : await user.placeZeroXOrder(params)
        } catch(e) {
          this.log(e);
        }
      } else {
        fillOrder ?
        await user.takeBestOrder(
          String(args.marketId),
          new BigNumber(type),
          onChainShares,
          onChainPrice,
          new BigNumber(String(args.outcome)),
          tradeGroupId
        ) :
        await user.placeOrder(
          String(args.marketId),
          new BigNumber(type),
          onChainShares,
          onChainPrice,
          new BigNumber(String(args.outcome)),
          nullOrderId,
          nullOrderId,
          tradeGroupId
        );
      }
      this.log(`place order ${result}`);

    },
  });

  flash.addScript({
    name: 'take-orderbook-side',
    options: [
      {
        name: 'skipFaucet',
        abbr: 's',
        description: 'skip faucet&approve. use if re-running this script',
        flag: true,
      },
      {
        name: 'userAccount',
        abbr: 'u',
        description: 'user account to create the order',
      },
      {
        name: 'outcome',
        abbr: 'o',
        description: 'orderbook outcome to take, default is 2'
      },
      {
        name: 'market',
        abbr: 'm',
        description: 'market to trade, default is a random market',
      },
      {
        name: 'limit',
        abbr: 'l',
        description: 'limit of orders to take, 1...N orders can be take, default is keep taking forever',
      },
      {
        name: 'wait',
        abbr: 'w',
        description: 'how many seconds to wait between takes. default=1',
      },
      {
        name: 'orderType',
        abbr: 't',
        description: 'side of orderbook to take, bid or ask, bid is default',
      },
    ],
    async call(this: FlashSession, args :FlashArguments) {
      const skipFaucet = args.skipFaucet as boolean;
      const address = args.userAccount ? String(args.userAccount) : null;
      const marketId = args.market ? String(args.market) : null;
      const limit = args.limit ? Number(args.limit) : 86400000; // go for a really long time
      const orderType = args.orderType ? String(args.orderType) : 'bid';
      const outcome = args.outcome ? Number(args.outcome) : 2;
      const wait = Number(String(args.wait)) || 1;

      const user: ContractAPI = await this.ensureUser(this.network, true, true, address, true, true);

      if (!skipFaucet) {
        console.log('fauceting ...');
        const funds = new BigNumber(1e18).multipliedBy(1000000);
        await user.faucetOnce(funds);
        await user.approve(funds);
      }

      const markets = (await user.getMarkets()).markets;
      const market = marketId ? markets.find(m => m.id === marketId) : markets[0];

      const direction = orderType === 'bid' || orderType === 'buy' ? '0' : '1';
      const takeDirection = direction === '0' ? 1 : 0;
      let i = 0;
      for(i; i < limit; i++) {
        const orders = flattenZeroXOrders(await user.getOrders(market.id, direction, outcome));
        if (orders.length > 0) {
          const sortedOrders =
            direction === '0'
              ? orders.sort((a, b) =>
                  new BigNumber(b.price).minus(new BigNumber(a.price)).toNumber()
                )
              : orders.sort((a, b) =>
                  new BigNumber(a.price).minus(new BigNumber(b.price)).toNumber()
                );

          const order = sortedOrders[0];
          console.log('Take Order', order.amount, '@', order.price);
          const params: NativePlaceTradeDisplayParams = {
            market: market.id,
            direction: takeDirection as 0 | 1,
            outcome: Number(outcome) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
            numTicks: new BigNumber(market.numTicks),
            numOutcomes: market.numOutcomes,
            tradeGroupId: stringTo32ByteHex('tradegroupId'),
            fingerprint: stringTo32ByteHex('fingerprint'),
            doNotCreateOrders: true,
            displayAmount: new BigNumber(order.amount),
            displayPrice: new BigNumber(order.price),
            displayMaxPrice: new BigNumber(market.maxPrice),
            displayMinPrice: new BigNumber(market.minPrice),
            displayShares: new BigNumber(0),
          };
          await user.augur.placeTrade(params).catch(e => console.error(e));
        }
        await sleep(wait * 1000);
      }
    },
  });

  flash.addScript({
    name: 'fake-all',
    options: [
      {
        name: 'createMarkets',
        abbr: 'c',
        description:
          'create canned markets',
        flag: true,
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      await this.call('deploy', {
        timeControlled: true,
      });
      const createMarkets = Boolean(args.createMarkets);
      if (createMarkets) {
        await this.call('create-canned-markets', {});
      }
    },
  });

  flash.addScript({
    name: 'normal-all',
    options: [
      {
        name: 'createMarkets',
        abbr: 'c',
        description:
          'create canned markets',
        flag: true,
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      await this.call('deploy', {
        timeControlled: false,
      });
      const createMarkets = Boolean(args.createMarkets);
      if (createMarkets) {
        await this.call('create-canned-markets', {});
      }
    },
  });

  flash.addScript({
    name: 'all-logs',
    options: [
      {
        name: 'quiet',
        abbr: 'q',
        description:
          'Do not print anything (just returns). Only useful in interactive mode.',
        flag: true,
      },
      {
        name: 'v1',
        description: 'Fetch logs from V1 contracts.',
        flag: true,
      },
      {
        name: 'from',
        abbr: 'f',
        description: 'First block from which to request logs.',
      },
      {
        name: 'to',
        abbr: 't',
        description: 'Final block from which to request logs.',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return [];
      const user = await this.ensureUser(null, false, false);
      const quiet = args.quiet as boolean;
      const v1 = args.v1 as boolean;
      const fromBlock = Number(args.from || 0);
      const toBlock =
        args.to === null || args.to === 'latest' ? 'latest' : Number(args.to);

      const logs = await this.provider.getLogs({
        address: user.augur.config.addresses.Augur,
        fromBlock,
        toBlock,
        topics: [],
      });

      const logsWithBlockNumber = logs.map(log => ({
        ...log,
        logIndex: log.logIndex || 0,
        transactionHash: log.transactionHash || '',
        transactionIndex: log.transactionIndex || 0,
        blockNumber: log.blockNumber || 0,
        blockHash: log.blockHash || '0',
        removed: log.removed || false,
      }));

      let parsedLogs = user.augur.contractEvents.parseLogs(logsWithBlockNumber);

      // Logs from AugurV1 require additional calls to the blockchain.
      if (v1) {
        parsedLogs = await Promise.all(
          parsedLogs.map(async log => {
            if (log.name === 'OrderCreated') {
              const { shareToken } = log;
              const shareTokenContract = new ethers.Contract(
                shareToken,
                new ethers.utils.Interface(abiV1.ShareToken),
                this.provider
              );
              const market = await shareTokenContract.functions['getMarket']();
              const outcome = (await shareTokenContract.functions[
                'getOutcome'
              ]()).toNumber();

              return Object.assign({}, log, { market, outcome });
            } else {
              return log;
            }
          })
        );
      }

      if (!quiet) {
        this.log(JSON.stringify(parsedLogs, null, 2));
      }
      return parsedLogs;
    },
  });

  flash.addScript({
    name: 'whoami',
    async call(this: FlashSession) {
      if (this.noProvider()) return;
      const user = await this.ensureUser();

      this.log(`You are ${user.account.publicKey}\n`);
    },
  });

  flash.addScript({
    name: 'generate-templates',
    async call(this: FlashSession) {
      generateTemplateValidations().then(() => {
        this.log('Generated Templates to augur-artifacts\n');
      });
    },
  });

  flash.addScript({
    name: 'show-template',
    options: [
      {
        name: 'hash',
        description: 'Hash value of template to show',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const hash = String(args.hash);
      this.log(hash);
      const template = showTemplateByHash(hash);
      if (!template) this.log(`Template not found for hash ${hash}`);
      this.log(JSON.stringify(template, null, ' '));
      return template;
    },
  });

  flash.addScript({
    name: 'validate-template',
    options: [
      {
        name: 'title',
        description: 'populated market title',
        required: true,
      },
      {
        name: 'templateInfo',
        description: 'string version of template information from market creation extraInfo, it will be parsed as object internally',
        required: true,
      },
      {
        name: 'outcomes',
        description: 'string array of outcomes if market is categorical',
        required: false,
      },
      {
        name: 'resolutionRules',
        description: 'resolution rules separated by \n ',
        required: true,
      },
      {
        name: 'endTime',
        description: 'market end time, also called event expiration',
        required: true,
      }
    ],
    async call(this: FlashSession, args: FlashArguments) {
      let result = null;
      try {
        const title = String(args.title);
        const templateInfo = String(args.templateInfo);
        const outcomesString = String(args.outcomes);
        const resolutionRules = String(args.resolutionRules);
        const endTime = Number(args.endTime);
        result = validateMarketTemplate(title, templateInfo, outcomesString, resolutionRules, endTime);
        this.log(result);
      } catch (e) {
        this.log(e);
      }
      return result;
    },
  });

  flash.addScript({
    name: 'get-timestamp',
    async call(this: FlashSession) {
      if (this.noProvider()) return 0;
      const user = await this.contractOwner();

      const blocktime = await user.getTimestamp();
      const epoch = Number(blocktime.toString()) * 1000;

      this.log(`block: ${blocktime}`);
      this.log(`local: ${moment(epoch).toString()}`);
      this.log(
        `utc: ${moment(epoch)
          .utc()
          .toString()}\n`
      );
      return blocktime;
    },
  });

  flash.addScript({
    name: 'set-timestamp',
    options: [
      {
        name: 'timestamp',
        abbr: 't',
        description:
          "Uses Moment's parser but also accepts millisecond unix epoch time. See https://momentjs.com/docs/#/parsing/string/",
        required: true,
      },
      {
        name: 'format',
        abbr: 'f',
        description:
          'Lets you specify the format of --timestamp. See https://momentjs.com/docs/#/parsing/string-format/',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.contractOwner();

      const timestamp = args.timestamp as string;
      const format = (args.format as string) || undefined;

      let epoch = Number(timestamp);
      if (isNaN(epoch)) {
        epoch = moment(timestamp, format).valueOf();
      }

      await user.setTimestamp(new BigNumber(epoch));
      await this.call('get-timestamp', {});
    },
  });

  flash.addScript({
    name: 'push-timestamp',
    options: [
      {
        name: 'count',
        abbr: 'c',
        description:
          'Defaults to seconds. Use "y", "M", "w", "d", "h", or "m" for longer times. ex: "2w" is 2 weeks.',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.contractOwner();

      const countString = args.count as string;
      let unit = countString[countString.length - 1];
      let count: string;
      if (['y', 'M', 'w', 'd', 'h', 'm', 's'].includes(unit.toString())) {
        count = countString.slice(0, countString.length - 1);
      } else {
        count = countString;
        unit = 's'; // no unit provided so default to seconds
      }
      const blocktime = Number(await user.getTimestamp()) * 1000;
      const newTime = moment(blocktime).add(count, unit as
        | 'y'
        | 'M'
        | 'w'
        | 'd'
        | 'h'
        | 'm'
        | 's');

      await this.call('get-timestamp', {});
      this.log(`changing timestamp to ${newTime.unix()}`);
      await user.setTimestamp(new BigNumber(newTime.unix()));
      await this.call('get-timestamp', {});
    },
  });

  flash.addScript({
    name: 'initial-report',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description: 'market to initially report on',
        required: true,
      },
      {
        name: 'extraStake',
        abbr: 's',
        description:
          'added pre-emptive REP stake on the outcome in 10**18 format not atto REP(optional)',
        required: false,
      },
      {
        name: 'description',
        abbr: 'd',
        description:
          'description to be added to contracts for initial report (optional)',
        required: false,
      },
      {
        name: 'payoutNumerators',
        abbr: 'p',
        description: 'payout numerators of child unverse.',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.ensureUser();
      const marketId = args.marketId as string;
      const extraStake = args.extraStake as string;
      const desc = args.description as string;
      let preEmptiveStake = '0';
      if (extraStake) {
        preEmptiveStake = new BigNumber(extraStake)
          .multipliedBy(QUINTILLION)
          .toFixed();
      }

      const market: ContractInterfaces.Market = await user.getMarketContract(
        marketId
      );

      const payout = String(args.payoutNumerators)
      .split(',')
      .map(i => new BigNumber(i));

      await user.doInitialReport(
        market,
        payout,
        desc,
        preEmptiveStake
      );
    },
  });

  flash.addScript({
    name: 'dispute',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description: 'market to dispute',
        required: true,
      },
      {
        name: 'amount',
        abbr: 'a',
        description: 'amount of REP to dispute with, use display value',
        required: false,
      },
      {
        name: 'description',
        abbr: 'd',
        description:
          'description to be added to contracts for dispute (optional)',
        required: false,
      },
      {
        name: 'payoutNumerators',
        abbr: 'p',
        description: 'payout numerators of child unverse.',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      this.config.gsn.enabled = false;
      const user: ContractAPI = await this.ensureUser();
      const payout = String(args.payoutNumerators)
        .split(',')
        .map(i => new BigNumber(i));

      const marketId = args.marketId as string;
      const amount = args.amount as string;
      const desc = args.description as string;
      if (amount === '0') return this.log('amount of REP is required');
      const stake = new BigNumber(amount).multipliedBy(QUINTILLION);

      const market: ContractInterfaces.Market = await user.getMarketContract(
        marketId
      );

      await user.contribute(market, payout, stake, desc);
    },
  });

  flash.addScript({
    name: 'contribute-to-tentative-winning-outcome',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description:
          'market to contribute REP to its tentative winning outcome',
        required: true,
      },
      {
        name: 'amount',
        abbr: 'a',
        description: 'amount of REP to dispute with, use display value',
        required: true,
      },
      {
        name: 'description',
        abbr: 'd',
        description:
          'description to be added to contracts for contribution (optional)',
        required: false,
      },
      {
        name: 'payoutNumerators',
        abbr: 'p',
        description: 'payout numerators of child unverse.',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      this.config.gsn.enabled = false;
      const user = await this.ensureUser();
      const marketId = args.marketId as string;
      const amount = args.amount as string;
      const desc = args.description as string;

      if (amount === '0') return this.log('amount of REP is required');
      const stake = new BigNumber(amount).multipliedBy(QUINTILLION);

      if (!this.sdkReady) {
        return this.log("SDK hasn't fully syncd, need to wait");
      }

      const market: ContractInterfaces.Market = await user.getMarketContract(
        marketId
      );

      const payout = String(args.payoutNumerators)
        .split(',')
        .map(i => new BigNumber(i));

      await user.contributeToTentative(market, payout, stake, desc);
    },
  });

  flash.addScript({
    name: 'finalize',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description: 'market to finalize',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      this.config.gsn.enabled = false;
      const user = await this.ensureUser();
      const marketId = args.marketId as string;

      const market: ContractInterfaces.Market = await user.getMarketContract(
        marketId
      );
      await user.finalizeMarket(market);
    },
  });

  flash.addScript({
    name: 'fork',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description: 'yes/no market to fork. defaults to making one',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      this.config.gsn.enabled = false;
      const user = await this.ensureUser();
      let marketId = args.marketId ? String(args.marketId) : null;
      let market: ContractInterfaces.Market = null;

      if (!marketId) {
        market = await this.call('create-reasonable-yes-no-market', {title: 'forking market'});
        console.log('created market', market.address);
      } else {
        market = await user.getMarketContract(
          marketId
        );
      }

      if (await fork(user, market)) {
        this.log('Fork successful!');
      } else {
        this.log('ERROR: forking failed.');
      }
    },
  });

  flash.addScript({
    name: 'dispute-rounds',
    options: [
      {
        name: 'marketId',
        abbr: 'm',
        description: 'yes/no market to dispute. defaults to making one',
      },
      {
        name: 'slow',
        abbr: 's',
        description: 'puts market into slow pacing mode immediately',
        flag: true,
      },
      {
        name: 'rounds',
        abbr: 'r',
        description: 'number of rounds to complete',
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      if (this.noProvider()) return;
      const user = await this.ensureUser(this.network, true);
      const slow = args.slow as boolean;
      const rounds = args.rounds ? Number(args.rounds) : 0;

      let marketId = (args.marketId as string) || null;
      if (marketId === null) {
        const market = await user.createReasonableYesNoMarket();
        marketId = market.address;
        this.log(`Created market ${marketId}`);
      }

      await sleep(2000);
      const marketInfos = (await user.getMarketInfo(marketId));
      if (!marketInfos || marketInfos.length === 0) {
        return this.log(`Error: marketId: ${marketId} not found`);
      }
      const marketInfo = marketInfos[0];
      await dispute(user, marketInfo, slow, rounds);
    },
  });

  flash.addScript({
    name: 'markets',
    async call(this: FlashSession): Promise<MarketList | null> {
      if (this.noProvider()) return null;
      const user = await this.ensureUser(this.network, true);

      const markets: MarketList = await user.getMarkets();
      console.log(JSON.stringify(markets, null, 2));
      return markets;
    },
  });

  flash.addScript({
    name: 'network-id',
    async call(this: FlashSession): Promise<string> {
      if (this.noProvider()) return null;

      const networkId = await this.provider.getNetworkId();
      console.log(networkId);
      return networkId;
    },
  });

  flash.addScript({
    name: 'docker-all',
    ignoreNetwork: true,
    options: [
      {
        name: 'dev',
        abbr: 'd',
        description: 'Deploy to node instead of using pop-docker image. With --do-not-run-geth, deploys to existing node',
        flag: true,
      },
      {
        name: 'fake',
        abbr: 'f',
        description: 'Use fake time (TimeControlled) instead of real time',
        flag: true,
      },
      {
        name: 'detach',
        abbr: 'D',
        description: 'Do not stop dockers after running command and do not wait for user input before exiting',
        flag: true,
      },
      {
        name: 'do-not-run-geth',
        abbr: 'G',
        description: 'Do not start up a geth node; with --dev will deploy and create markets on existing geth node, if it exists',
        flag: true,
      },
      {
        name: 'do-not-create-markets',
        abbr: 'M',
        description: 'Do not create markets. Only applies when --dev is specified.',
        flag: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGHUP');

      const dev = Boolean(args.dev);
      const fake = Boolean(args.fake);
      const detach = Boolean(args.detach);
      const runGeth = !Boolean(args.doNotRunGeth);
      const createMarkets = !Boolean(args.doNotCreateMarkets);

      spawnSync('docker', ['pull', '0xorg/mesh:latest']);

      this.log(`Deploy contracts: ${dev}`);
      this.log(`Use fake time: ${fake}`);
      this.log(`Detach: ${detach}`);
      this.log(`Start geth node: ${runGeth}`);
      if (dev) this.log(`Create markets: ${createMarkets}`);

      let env;
      try {
        if (runGeth) {
          if (dev) {
            spawnSync('yarn', ['workspace', '@augurproject/tools', 'docker:geth:detached']);
          } else {
            const gethDocker = fake ? 'docker:geth:pop' : 'docker:geth:pop-normal-time';
            spawnSync('yarn', [gethDocker]);
          }
          this.log('Waiting for Geth to start up');
          await sleep(10000); // give geth some time to start
          await refreshSDKConfig();
        }

        this.config = buildConfig('local');
        this.provider = flash.makeProvider(this.config);

        if (dev) {
          this.log('Deploying contracts');
          const deployMethod = fake ? 'fake-all' : 'normal-all';
          await this.call(deployMethod, { createMarkets, parallel: true });
        }

        this.log('Building');
        await spawnSync('yarn', ['build']); // so UI etc will have the correct addresses

        // Run the GSN relay
        this.log('Running GSN relayer');
        spawn('yarn', ['run:gsn'], {stdio: 'inherit'});

        env = {
          ...process.env,
          ETHEREUM_CHAIN_ID: this.config.networkId,
          CUSTOM_CONTRACT_ADDRESSES: JSON.stringify(this.config.addresses),
          ZEROX_CONTRACT_ADDRESS: formatAddress(this.config.addresses.ZeroXTrade, { lower: true, prefix: false }),
        };

        this.log('Running dockers. Type ctrl-c to quit:');
        await spawnSync('docker-compose', ['-f', 'docker-compose.yml', 'up', '-d'], {
          env,
          stdio: 'inherit'
        });

        if (detach) return;

        spawn('docker-compose', ['-f', 'docker-compose.yml', 'logs'], {env, stdio: 'inherit'});
        await waitForSigint();
      } catch (err) {
        console.log(`Error: ${err}`);
      } finally {
        if (!detach) {
          if (runGeth) {
            this.log('Stopping geth');
            await spawnSync('docker', ['kill', 'geth'], { stdio: 'inherit' });
          }
          this.log('Stopping dockers');
          await spawn('docker-compose', ['-f', 'docker-compose.yml', 'down'], {env, stdio: 'inherit'});
        }
      }
    }
  });

  flash.addScript({
    name: 'sdk-server',
    ignoreNetwork: true,
    async call(this: FlashSession) {
      const api = await startServer(this.config, this.account);
      const app = createApp(api);

      const httpServer = this.config.server?.startHTTP && runHttpServer(app, this.config);
      const httpsServer = this.config.server?.startHTTPS && runHttpsServer(app, this.config);
      const wsServer = this.config.server?.startWS && runWsServer(api, app, this.config);
      const wssServer = this.config.server?.startWSS && runWssServer(api, app, this.config);

      this.log('Running SDK server. Type ctrl-c to quit:\n');
      await waitForSigint();
      httpServer.close();
      httpsServer.close();
      wsServer.close();
      wssServer.close();
    }
  });

  flash.addScript({
    name: 'get-contract-address',
    options: [
      {
        name: 'name',
        abbr: 'n',
        description: 'Name of contract',
        required: true,
      },
      {
        name: 'removePrefix',
        abbr: 'r',
        description: 'If specified will remove the 0x prefix',
        flag: true,
      },
      {
        name: 'lower',
        abbr: 'l',
        description: 'If specified will toLowerCase the result',
        flag: true,
      },
    ],
    async call(
      this: FlashSession,
      args: FlashArguments
    ): Promise<string> {
      const name = args.name as string;
      const removePrefix = args.removePrefix as boolean;
      const lower = args.lower as boolean;
      let address = this.config.addresses[name];
      address = formatAddress(address, { lower, prefix: !removePrefix});
      this.log(address);
      return address;
    },
  });

  flash.addScript({
    name: 'get-all-contract-addresses',
    options: [
      {
        name: 'ugly',
        abbr: 'u',
        description: 'print the addresses json as a blob instead of nicely formatted',
        flag: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const ugly = args.ugly as boolean;
      if (this.noProvider()) return;

      if (ugly) {
        console.log(JSON.stringify(this.config.addresses))
      } else {
        console.log(JSON.stringify(this.config.addresses, null, 2))
      }
    },
  });

  flash.addScript({
    name: 'add-eth-exchange-liquidity',
    options: [
      {
        name: 'ethAmount',
        abbr: 'e',
        description: 'amount of ETH to provide to the exchange',
        required: true,
      },
      {
        name: 'cashAmount',
        abbr: 'c',
        description: 'amount of DAI to provide to the exchange',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const attoEth = new BigNumber(Number(args.ethAmount)).times(_1_ETH);
      const attoCash = new BigNumber(Number(args.cashAmount)).times(_1_ETH);

      const user = await this.ensureUser();

      await user.addEthExchangeLiquidity(attoCash, attoEth);
    },
  });

  flash.addScript({
    name: 'deposit-relay',
    options: [
      {
        name: 'ethAmount',
        abbr: 'e',
        description: 'amount of ETH to provide to the exchange',
      },
      {
        name: 'relayHub',
        abbr: 'r',
        description: 'address to relay hub',
        required: true,
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const address = String(args.relayHub);
      const attoEth = args.ethAmount ? new BigNumber(Number(args.ethAmount)).times(_1_ETH) : new BigNumber(1).times(_1_ETH);

      const user = await this.ensureUser();

      await user.depositRelay(address, attoEth);
    },
  });

  flash.addScript({
    name: 'init-warp-sync',
    async call(this: FlashSession) {
      const user = await this.ensureUser();

      await user.initWarpSync(user.augur.contracts.universe.address);
    },
  });

  flash.addScript({
    name: 'eth-balance',
    options: [
      {
        name: 'target',
        abbr: 't',
        description: 'which account to check. defaults to current account',
      },
    ],
    async call(this: FlashSession, args: FlashArguments): Promise<BigNumber> {
      const target = args.target as string;
      const user = await this.ensureSimpleUser();
      const balance = await user.getEthBalance(target || this.account);
      this.log(balance.toFixed());
      return balance;
    },
  });

  flash.addScript({
    name: 'cash-balance',
    options: [
      {
        name: 'target',
        abbr: 't',
        description: 'which account to check. defaults to current account',
      },
    ],
    async call(this: FlashSession, args: FlashArguments): Promise<BigNumber> {
      const target = args.target as string;
      const user = await this.ensureSimpleUser();
      const balance = await user.getCashBalance(target || this.account);
      this.log(balance.toFixed());
      return balance;
    },
  });

  flash.addScript({
    name: 'rep-balance',
    options: [
      {
        name: 'target',
        abbr: 't',
        description: 'which account to check. defaults to current account',
      },
    ],
    async call(this: FlashSession, args: FlashArguments): Promise<BigNumber> {
      const target = args.target as string;
      const user = await this.ensureSimpleUser();
      const balance = await user.getRepBalance(target || this.account);
      this.log(balance.toFixed());
      return balance;
    },
  });

  flash.addScript({
    name: 'ping',
    ignoreNetwork: true,
    async call(this: FlashSession) {
      this.log('pong');
    },
  });

  flash.addScript({
    name: 'take-order',
    options: [
      {
        name: 'market',
        abbr: 'm',
        description: 'market address/id',
        required: true,
      },
      {
        name: 'direction',
        abbr: 'd',
        description: '0 = bid/long; 1 = ask/short',
        required: true,
      },
      {
        name: 'outcome',
        abbr: 'o',
        description: '0 = invalid; for yes/no markets: 1 = no, 2 = yes',
        required: true,
      },
      {
        name: 'wait-time-for-0x',
        abbr: 'w',
        description: 'how many milliseconds to wait for 0x orders to arrive. default=90000',
      },
    ],
    async call(this: FlashSession, args: FlashArguments): Promise<void> {
      const marketAddress = args.market as string;
      const direction = Number(args.direction);
      const outcome = Number(args.outcome);
      const waitTimeForZeroX = Number(args.waitTimeFor0x) || 90000;

      const user = await this.ensureUser(this.network, null, false, null, true, false);
      await waitForSync(user);
      const marketInfo = (await this.user.getMarketInfo(marketAddress))[0];

      console.log('Waiting for 0x orders to arrive');
      await sleep(waitTimeForZeroX);

      await takeOrder(user, marketInfo, direction, outcome);
    }});

  flash.addScript({
    name: 'perf-setup',
    options: [
      {
        name: 'market-makers',
        abbr: 'm',
        description: 'how many market makers to create. each makes 10 markets. default zero'
      },
      {
        name: 'traders',
        abbr: 't',
        description: 'how many traders to create. default zero',
      },
      {
        name: 'serial',
        abbr: 's',
        description: 'make only one contract call at a time'
      },
    ],
    async call(this: FlashSession, args: FlashArguments) {
      const marketMakerCount = Number(args.marketMakers || 0);
      const traderCount = Number(args.traders || 0);
      const serial = Boolean(args.serial);

      if (!marketMakerCount && !traderCount) {
        throw Error('perf-setup requires market-makers or traders to be specified');
      }

      const accountCreator = new AccountCreator(BASE_MNEMONIC);
      const marketMakerAccounts = accountCreator.marketMakers(marketMakerCount);
      const traderAccounts = accountCreator.traders(traderCount);
      const ethSource = await this.ensureSimpleUser(this.network);
      if (marketMakerCount > 0) {
        const makers: ContractAPI[] = await setupUsers(marketMakerAccounts, ethSource, new BigNumber(FINNEY).times(40), this.config, serial);
        const markets: Market[] = await setupMarkets(makers, serial);
        console.log('Created markets:', markets.map((market) => market.address).join(','))
      }
      if (traderCount > 0) {
        await setupUsers(traderAccounts, ethSource, new BigNumber(FINNEY).times(5), this.config, serial);
        console.log('Created traders:')
        traderAccounts.forEach((trader, index) => {
          console.log(`#${index}: ${trader.secretKey} -> ${trader.publicKey}`);
        })
      }
    }
  });

  flash.addScript({
    name: 'perf-make-orders',
    options: [
      {
        name: 'market-makers',
        abbr: 'm',
        description: 'how many market makers. uses standard account range. used to infer market list',
      },
      {
        name: 'traders',
        abbr: 't',
        description: 'how many perf traders. uses standard account range',
      },
      {
        name: 'zerox-batch-size',
        abbr: 'b',
        description: 'how many 0x orders to create at a time'
      },
      {
        name: 'expiration',
        abbr: 'e',
        description: 'how many seconds until orders expire. default is 1 hour'
      },
    ],
    async call(this: FlashSession, args: FlashArguments): Promise<void> {
      const makerCount = Number(args.marketMakers || 10);
      const traderCount = Number(args.traders || 200);
      const zeroxBatchSize = Number(args.zeroxBatchSize || 25);
      const expiration = new BigNumber(args.expiration as string || 60*60);
      const { config, zeroX } = setupPerfConfigAndZeroX(this.config);
      const ethSource = await this.ensureSimpleUser(this.network);
      const accountCreator = new AccountCreator(BASE_MNEMONIC);
      const traderAccounts = accountCreator.traders(traderCount);
      const makerAccounts = accountCreator.marketMakers(makerCount);
      const traders = await ContractAPI.wrapUsers(traderAccounts, ethSource.provider, config, undefined, zeroX);

      await waitForSync(ethSource);
      const markets = (await getAllMarkets(ethSource, makerAccounts)).map((market) => market.id);
      const shapers = setupOrderBookShapers(markets, 10, expiration);
      const orders = await setupOrders(this.user, shapers);

      await createOrders(traders, orders, zeroxBatchSize);
      console.log(`Created ${orders.length} orders`);
    }
  });

  flash.addScript({
    name: 'perf-take-orders',
    options: [
      {
        name: 'market-makers',
        abbr: 'm',
        description: 'how many market makers. uses standard account range. used to infer market list. defaults to 10 (100 markets)',
      },
      {
        name: 'traders',
        abbr: 't',
        description: 'how many perf traders. uses standard account range. defaults to 200',
      },
      {
        name: 'limit',
        abbr: 'l',
        description: 'maximum number of orders to take. defaults to 10^20',
      },
      {
        name: 'period',
        abbr: 'p',
        description: 'how often to take orders, in milliseconds. defaults to 1000',
      },
      {
        name: 'wait-time-for-0x',
        abbr: 'w',
        description: 'how many milliseconds to wait for 0x orders to arrive. default=90000',
      },
      {
        name: 'outcomes',
        abbr: 'o',
        description: 'outcomes that can be taken. JSON-encoded array of numbers 0-7 like "[1,2]"',
      },
    ],
    async call(this: FlashSession, args: FlashArguments): Promise<void> {
      const makerCount = Number(args.marketMakers || 10);
      const traderCount = Number(args.traders || 200);
      const limit = Number(args.limit || 1e20);
      const periodMS = Number(args.period || 1000);
      const waitTimeForZeroX = Number(args.waitTimeFor0x) || 90000;
      const outcomes = JSON.parse(args.outcomes as string || '[1,2]');

      const { config, zeroX } = setupPerfConfigAndZeroX(this.config);
      const ethSource = await this.ensureUser(this.network, null, false, null, true, false);
      const accountCreator = new AccountCreator(BASE_MNEMONIC);
      const traderAccounts = accountCreator.traders(traderCount);
      const makerAccounts = accountCreator.marketMakers(makerCount);
      const connector = ethSource.augur.connector
      const traders = await ContractAPI.wrapUsers(traderAccounts, ethSource.provider, config, connector, zeroX);

      await waitForSync(ethSource);
      console.log('Waiting for 0x orders to arrive');
      await sleep(waitTimeForZeroX);
      const markets = await getAllMarkets(ethSource, makerAccounts);
      await takeOrders(traders, markets, periodMS, limit, outcomes);
    }});

  flash.addScript({
    name: 'perf-accounts',
    ignoreNetwork: true,
    options: [
      {
        name: 'market-makers',
        abbr: 'm',
        description: 'how many market makers. uses standard account range. used to infer market list. defaults to 10 (100 markets)',
      },
      {
        name: 'traders',
        abbr: 't',
        description: 'how many perf traders. uses standard account range. defaults to 200',
      },
    ],
    async call(this: FlashSession, args: FlashArguments): Promise<void> {
      const makerCount = Number(args.marketMakers || 10);
      const traderCount = Number(args.traders || 200);
      const accountCreator = new AccountCreator(BASE_MNEMONIC);
      const makerAccounts = accountCreator.marketMakers(makerCount);
      const traderAccounts = accountCreator.traders(traderCount);

      console.log('Market Makers:');
      makerAccounts.forEach((maker) => {
        console.log(`${maker.secretKey} -> ${maker.publicKey}`);
      })
      console.log();
      console.log('Traders:');
      traderAccounts.forEach((trader) => {
        console.log(`${trader.secretKey} -> ${trader.publicKey}`);
      })
    }});
}
