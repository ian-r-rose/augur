pragma solidity 0.5.4;

import "../reporting/IV2ReputationToken.sol";
import "../reporting/IUniverse.sol";
import "../reporting/IV2ReputationToken.sol";
import "../reporting/IUniverse.sol";
import "../IAugur.sol";
import "./IReputationTokenFactory.sol";









/**
 * @title TestNet Reputation Token Factory
 * @notice A Factory contract to create TestNet Reputation Token contracts
 * @dev Only meant for use in Testing environments. Only meant to be used by the universe corresponding to the token. This creates a normal contract rather than a delegate. As there shouldn't be many REP tokens in existance this will save on gas.
 */
contract TestNetReputationTokenFactory is IReputationTokenFactory {
    function createReputationToken(IAugur _augur, IUniverse _parentUniverse) public returns (IV2ReputationToken) {
        IUniverse _universe = IUniverse(msg.sender);
        IV2ReputationToken _reputationToken = IV2ReputationToken(new TestNetReputationToken(_augur, _universe, _parentUniverse, _augur.lookup("ERC1820Registry")));
        return _reputationToken;
    }
}
