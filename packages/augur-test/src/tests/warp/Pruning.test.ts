import { SECONDS_IN_A_DAY } from '@augurproject/sdk/build';
import { Seed, TestContractAPI } from '@augurproject/tools';
import { TestEthersProvider } from '@augurproject/tools/build/libs/TestEthersProvider';
import { makeProvider } from '../../libs';
import { ACCOUNTS, defaultSeedPath, loadSeedFile } from '@augurproject/tools';

describe('market pruning', () => {
  let provider: TestEthersProvider;
  let john: TestContractAPI;
  let mary: TestContractAPI;
  let seed: Seed;

  beforeEach(async () => {
    seed = await loadSeedFile(defaultSeedPath, 'prune');
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
    await john.sync();

    await expect(john.api.route(
      'getMarkets',
      {
        universe: seed.addresses.Universe
      }
    )).resolves.toEqual({
      'markets': [
        expect.any(Object)
      ],
      'meta': expect.any(Object)
    });

    // advance 30 days.
    for (let i = 0; i < 31; i++) {
      await john.advanceTimestamp(SECONDS_IN_A_DAY);
      await john.sync();
    }

    await expect(john.api.route(
      'getMarkets',
      {
        universe: seed.addresses.Universe
      }
    )).resolves.toEqual({
      'markets': [
      ],
      'meta': expect.any(Object)
    });
  });
});
