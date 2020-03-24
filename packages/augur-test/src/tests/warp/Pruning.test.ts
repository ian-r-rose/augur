import { SECONDS_IN_A_DAY } from '@augurproject/sdk';
import { TestContractAPI } from '@augurproject/tools';
import { TestEthersProvider } from '@augurproject/tools/build/libs/TestEthersProvider';
import { BigNumber } from 'bignumber.js';
import { makeProvider } from '../../libs';
import { ACCOUNTS, defaultSeedPath, loadSeedFile } from '@augurproject/tools';

describe('market pruning', () => {

  let provider: TestEthersProvider;
  let john: TestContractAPI;
  let mary: TestContractAPI;

  beforeEach(async () => {
    const seed = await loadSeedFile(defaultSeedPath, 'prune');
    provider = await makeProvider(seed, ACCOUNTS);
    const config = provider.getConfig();

    john = await TestContractAPI.userWrapper(
      ACCOUNTS[0],
      provider,
      config,
    );

    mary = await TestContractAPI.userWrapper(
      ACCOUNTS[1],
      provider,
      config,
    );

    await john.sync();
  });

  afterEach(() => {
    john = null;
    mary = null;
  });

  test('should remove markets from db that have been finalized for a period.', async () => {

  });
});
