import { Address, BigInt, log } from '@graphprotocol/graph-ts'
import { HubPosition } from '../types/schema'
import { ZERO_BI } from '../utils/constants'
import { getHubPositionId, getTierId } from '../utils/id'

export function loadHubPosition(
  poolId: string,
  owner: Address,
  positionRefId: BigInt,
  tierId: i32,
  tickIdxLower: i32,
  tickIdxUpper: i32
): HubPosition | null {
  return HubPosition.load(getHubPositionId(poolId, owner, positionRefId, tierId, tickIdxLower, tickIdxUpper))
}

export function loadOrCreateHubPosition(
  poolId: string,
  owner: Address,
  positionRefId: BigInt,
  tierId: i32,
  tickIdxLower: i32,
  tickIdxUpper: i32,
  token0Id: string,
  token1Id: string
): HubPosition {
  const id = getHubPositionId(poolId, owner, positionRefId, tierId, tickIdxLower, tickIdxUpper)
  let position = HubPosition.load(id)
  if (!position) {
    log.info('creating hub position: {}', [id])
    position = new HubPosition(id)
    position.owner = owner
    position.positionRefId = positionRefId
    position.pool = poolId
    position.poolId = poolId
    position.tier = getTierId(poolId, tierId)
    position.tierId = tierId
    position.tickLower = tickIdxLower
    position.tickUpper = tickIdxUpper
    position.liquidity = ZERO_BI
    position.limitOrderType = 0
    position.token0 = token0Id
    position.token1 = token1Id
  }

  return position
}
