pragma solidity 0.5.4;

import "../libraries/token/IStandardToken.sol";
import "./IReputationToken.sol";


contract IV2ReputationToken is IReputationToken, IStandardToken {
    function burnForMarket(uint256 _amountToBurn) public returns (bool);
    function mintForUniverse(uint256 _amountToMint, address _target) public returns (bool);
}
