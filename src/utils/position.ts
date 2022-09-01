import { Address, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { Manager } from '../types/Manager/Manager'
import { Position, PositionSnapshot } from '../types/schema'
import { loadTransaction } from '../utils'
import { ADDRESS_ZERO, MANAGER_ADDRESS, ZERO_BD, ZERO_BI } from '../utils/constants'
import { getPoolId } from '../utils/pool'
import { getTickId } from '../utils/tick'
import { getTierId } from './tier'

export function getPosition(event: ethereum.Event, tokenId: BigInt): Position | null {
  let position = Position.load(tokenId.toString())
  if (position === null) {
    let contract = Manager.bind(Address.fromString(MANAGER_ADDRESS))
    let positionCall = contract.try_getPosition(tokenId)

    // the following call reverts in situations where the position is minted
    // and deleted in the same block - from my investigation this happens
    // in calls from  BancorSwap
    // (e.g. 0xf7867fa19aa65298fadb8d4f72d0daed5e836f3ba01f0b9b9631cdc6c36bed40)
    if (!positionCall.reverted) {
      let positionResult = positionCall.value
      let poolId = getPoolId(positionResult.value1, positionResult.value2)

      position = new Position(tokenId.toString())
      position.tokenId = tokenId
      // The owner gets correctly updated in the Transfer handler
      position.owner = Address.fromString(ADDRESS_ZERO)
      position.pool = poolId
      position.tier = getTierId(poolId, positionResult.value3)
      position.token0 = positionResult.value1.toHexString()
      position.token1 = positionResult.value2.toHexString()
      position.tickLower = getTickId(poolId, positionResult.value3, positionResult.value4)
      position.tickUpper = getTickId(poolId, positionResult.value3, positionResult.value5)
      position.liquidity = ZERO_BI
      position.limitOrderType = 0
      position.settlementSnapshotId = ZERO_BI
      position.depositedToken0 = ZERO_BD
      position.depositedToken1 = ZERO_BD
      position.withdrawnToken0 = ZERO_BD
      position.withdrawnToken1 = ZERO_BD
      position.collectedToken0 = ZERO_BD
      position.collectedToken1 = ZERO_BD
      position.collectedFeesToken0 = ZERO_BD
      position.collectedFeesToken1 = ZERO_BD
      position.transaction = loadTransaction(event).id
      position.feeGrowthInside0LastX64 = positionResult.value6.feeGrowthInside0Last
      position.feeGrowthInside1LastX64 = positionResult.value6.feeGrowthInside1Last

      position.amountDepositedUSD = ZERO_BD
      position.amountWithdrawnUSD = ZERO_BD
      position.amountCollectedUSD = ZERO_BD
    }
  }

  return position
}

export function updateFeeVars(position: Position, event: ethereum.Event, tokenId: BigInt): Position {
  let positionManagerContract = Manager.bind(event.address)
  let positionResult = positionManagerContract.try_getPosition(tokenId)
  if (!positionResult.reverted) {
    position.feeGrowthInside0LastX64 = positionResult.value.value6.feeGrowthInside0Last
    position.feeGrowthInside1LastX64 = positionResult.value.value6.feeGrowthInside1Last
    position.settlementSnapshotId = positionResult.value.value6.settlementSnapshotId
  }
  return position
}

export function savePositionSnapshot(position: Position, event: ethereum.Event): void {
  let positionSnapshot = new PositionSnapshot(position.id.concat('#').concat(event.block.number.toString()))
  positionSnapshot.owner = position.owner
  positionSnapshot.tokenId = position.tokenId
  positionSnapshot.pool = position.pool
  positionSnapshot.tier = position.tier
  positionSnapshot.position = position.id
  positionSnapshot.blockNumber = event.block.number
  positionSnapshot.timestamp = event.block.timestamp
  positionSnapshot.liquidity = position.liquidity
  positionSnapshot.limitOrderType = position.limitOrderType
  positionSnapshot.settlementSnapshotId = position.settlementSnapshotId
  positionSnapshot.depositedToken0 = position.depositedToken0
  positionSnapshot.depositedToken1 = position.depositedToken1
  positionSnapshot.withdrawnToken0 = position.withdrawnToken0
  positionSnapshot.withdrawnToken1 = position.withdrawnToken1
  positionSnapshot.collectedFeesToken0 = position.collectedFeesToken0
  positionSnapshot.collectedFeesToken1 = position.collectedFeesToken1
  positionSnapshot.transaction = loadTransaction(event).id
  positionSnapshot.feeGrowthInside0LastX64 = position.feeGrowthInside0LastX64
  positionSnapshot.feeGrowthInside1LastX64 = position.feeGrowthInside1LastX64
  positionSnapshot.save()
}
