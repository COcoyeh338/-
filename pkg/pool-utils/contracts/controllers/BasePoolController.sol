// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.7.0;

import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/Ownable.sol";

import "../BasePoolAuthorization.sol";
import "../interfaces/IBasePoolController.sol";
import "../interfaces/IControlledPool.sol";

/**
 * @dev Pool controller that serves as the "owner" of a Balancer pool, and is in turn owned by
 * an account empowered to make calls on this contract that are forwarded to the underlyling pool.
 *
 * While Balancer pool owners are immutable, ownership of this pool controller is transferrable.
 * The deployer will be the initial owner
 */
contract BasePoolController is IBasePoolController, Ownable {
    address public pool;

    // Optional metadata associated with this controller (or the pool bound to it)
    bytes private _metadata;

    event MetadataUpdated(bytes metadata);

    modifier withBoundPool {
        _ensurePoolIsBound();
        _;
    }

    /**
     * @dev The underlying pool owner is immutable, so its address must be known when the pool is deployed.
     * This means the controller needs to be deployed first. Yet the controller also needs to know the address
     * of the pool it is controlling.
     *
     * We could either pass in a pool factory and have the controller deploy the pool, or have an initialize
     * function to set the pool address after deployment. This decoupled mechanism seems cleaner.
     *
     * It means the pool address must be in storage vs immutable, but for infrequent admin operations, this is
     * acceptable.
     */
    function initialize(address poolAddress) external virtual override {
        _require(
            pool == address(0) && BasePoolAuthorization(poolAddress).getOwner() == address(this),
            Errors.INVALID_INITIALIZATION
        );

        pool = poolAddress;
    }

    /**
     * @dev Pass a call to BasePool's setSwapFeePercentage through to the underlying pool
     */
    function setSwapFeePercentage(uint256 swapFeePercentage) external virtual override onlyOwner withBoundPool {
        IControlledPool(pool).setSwapFeePercentage(swapFeePercentage);
    }

    /**
     * @dev Pass a call to BasePool's setAssetManagerPoolConfig through to the underlying pool
     */
    function setAssetManagerPoolConfig(IERC20 token, bytes memory poolConfig)
        external
        virtual
        override
        onlyOwner
        withBoundPool
    {
        IControlledPool(pool).setAssetManagerPoolConfig(token, poolConfig);
    }

    /**
     * @dev Getter for the optional metadata
     */
    function getMetadata() public view returns (bytes memory) {
        return _metadata;
    }

    /**
     * @dev Setter for the admin to set/update the metadata
     */
    function updateMetadata(bytes memory metadata) external onlyOwner {
        _updateMetadata(metadata);
    }

    function _updateMetadata(bytes memory metadata) internal virtual {
        _metadata = metadata;

        emit MetadataUpdated(metadata);
    }

    function _ensurePoolIsBound() private view {
        _require(pool != address(0), Errors.UNINITIALIZED);
    }
}
