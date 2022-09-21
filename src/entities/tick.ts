import { BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { Tick } from '../types/schema'
import { hubContract, ONE_BD, ZERO_BI } from '../utils/constants'
import { convertPoolIdToBytes, getTickId, getTierId } from '../utils/id'
import { bigDecimalExponated, decodeLiquidityD8, safeDiv } from '../utils/misc'

export function createTick(poolId: string, tierId: i32, tickIdx: i32, block: ethereum.Block): Tick {
  const tick = new Tick(getTickId(poolId, tierId, tickIdx))
  tick.tickIdx = tickIdx
  tick.pool = poolId
  tick.poolId = poolId
  tick.tier = getTierId(poolId, tierId)
  tick.tierId = tierId

  tick.createdAtTimestamp = block.timestamp
  tick.createdAtBlockNumber = block.number
  tick.liquidityGross = ZERO_BI
  tick.liquidityNet = ZERO_BI
  tick.liquidityProviderCount = ZERO_BI

  // 1.0001^tick is token1/token0.
  const price0 = bigDecimalExponated(BigDecimal.fromString('1.0001'), BigInt.fromI32(tickIdx))
  tick.price0 = price0
  tick.price1 = safeDiv(ONE_BD, price0)

  // tick.volumeToken0 = ZERO_BD
  // tick.volumeToken1 = ZERO_BD
  // tick.volumeUSD = ZERO_BD
  // tick.feesUSD = ZERO_BD
  // tick.untrackedVolumeUSD = ZERO_BD
  // tick.collectedFeesToken0 = ZERO_BD
  // tick.collectedFeesToken1 = ZERO_BD
  // tick.collectedFeesUSD = ZERO_BD
  tick.feeGrowthOutside0X64 = ZERO_BI
  tick.feeGrowthOutside1X64 = ZERO_BI
  tick.limitOrderTickSpacing0For1 = 0
  tick.limitOrderTickSpacing1For0 = 0
  tick.limitOrderLiquidity0For1 = BigInt.zero()
  tick.limitOrderLiquidity1For0 = BigInt.zero()
  tick.nextAbove = 0
  tick.nextBelow = 0

  return tick
}

export function updateTickFeeVarsAndSave(tick: Tick): void {
  // not all ticks are initialized so obtaining null is expected behavior
  const tickResult = hubContract.getTick(convertPoolIdToBytes(tick.poolId), tick.tierId, tick.tickIdx)
  const liquidityLower = decodeLiquidityD8(tickResult.liquidityLowerD8)
  const liquidityUpper = decodeLiquidityD8(tickResult.liquidityUpperD8)
  tick.liquidityNet = liquidityLower.minus(liquidityUpper)
  tick.liquidityGross = liquidityLower.abs().plus(liquidityUpper.abs())
  tick.feeGrowthOutside0X64 = tickResult.feeGrowthOutside0
  tick.feeGrowthOutside1X64 = tickResult.feeGrowthOutside1
  tick.nextAbove = tickResult.nextAbove
  tick.nextBelow = tickResult.nextBelow
  tick.save()
}
