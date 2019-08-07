pragma solidity 0.5.4;

import "../reporting/IUniverse.sol";
import "../reporting/IUniverse.sol";


contract IUniverseFactory {
    function createUniverse(IUniverse _parentUniverse, bytes32 _parentPayoutDistributionHash, uint256[] memory _payoutNumerators) public returns (IUniverse);
}
