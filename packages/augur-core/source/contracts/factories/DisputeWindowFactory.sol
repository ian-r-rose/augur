pragma solidity 0.5.4;

import "../reporting/IDisputeWindow.sol";
import "../reporting/IUniverse.sol";
import "../reporting/IDisputeWindow.sol";
import "../IAugur.sol";
import "./IDisputeWindowFactory.sol";
import "../libraries/CloneFactory.sol";









/**
 * @title Dispute Window Factory
 * @notice A Factory contract to create Dispute Window delegate contracts
 * @dev Cannot be used directly. Only called by Universe contracts
 */
contract DisputeWindowFactory is CloneFactory, IDisputeWindowFactory {
    function createDisputeWindow(IAugur _augur, uint256 _disputeWindowId, uint256 _windowDuration, uint256 _startTime) public returns (IDisputeWindow) {
        IUniverse _universe = IUniverse(msg.sender);
        require(_augur.isKnownUniverse(_universe), "DisputeWindowFactory: Universe specified is unrecognized by Augur");
        IDisputeWindow _disputeWindow = IDisputeWindow(createClone(_augur.lookup("DisputeWindow")));
        _disputeWindow.initialize(_augur, _universe, _disputeWindowId, _windowDuration, _startTime, _augur.lookup("ERC1820Registry"));
        return _disputeWindow;
    }
}
