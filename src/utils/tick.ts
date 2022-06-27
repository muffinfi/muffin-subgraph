import { BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { bigDecimalExponated, decodeLiquidityD8, safeDiv } from '.'
import { Tick, Tier } from '../types/schema'
import { hubContract, ONE_BD, ZERO_BD, ZERO_BI } from './constants'
import { updateTickDayData } from './intervalUpdates'
import { convertPoolIdToBytes } from './pool'
import { getTierId } from './tier'

export let MIN_TICK_IDX = -776363
export let MAX_TICK_IDX = 776363

export function getTickIdWithTierEntityId(tierId: string, tickIdx: i32): string {
  return tierId + '#' + tickIdx.toString()
}

export function getTickId(poolId: string, tierId: i32, tickIdx: i32): string {
  return getTickIdWithTierEntityId(getTierId(poolId, tierId), tickIdx)
}

export function createTick(tickId: string, tickIdx: i32, poolId: string, tierId: i32, event: ethereum.Event): Tick {
  let tick = new Tick(tickId)
  tick.tickIdx = tickIdx
  tick.pool = poolId
  tick.poolId = poolId
  tick.tier = getTierId(poolId, tierId)
  tick.tierId = tierId

  tick.createdAtTimestamp = event.block.timestamp
  tick.createdAtBlockNumber = event.block.number
  tick.liquidityGross = ZERO_BI
  tick.liquidityNet = ZERO_BI
  tick.liquidityProviderCount = ZERO_BI

  tick.price0 = ONE_BD
  tick.price1 = ONE_BD

  // 1.0001^tick is token1/token0.
  let price0 = bigDecimalExponated(BigDecimal.fromString('1.0001'), BigInt.fromI32(tickIdx))
  tick.price0 = price0
  tick.price1 = safeDiv(ONE_BD, price0)

  tick.volumeToken0 = ZERO_BD
  tick.volumeToken1 = ZERO_BD
  tick.volumeUSD = ZERO_BD
  tick.feesUSD = ZERO_BD
  tick.untrackedVolumeUSD = ZERO_BD
  tick.collectedFeesToken0 = ZERO_BD
  tick.collectedFeesToken1 = ZERO_BD
  tick.collectedFeesUSD = ZERO_BD
  tick.liquidityProviderCount = ZERO_BI
  tick.feeGrowthOutside0X64 = ZERO_BI
  tick.feeGrowthOutside1X64 = ZERO_BI

  return tick
}

export function updateTickFeeVarsAndSave(tick: Tick, event: ethereum.Event): void {
  // not all ticks are initialized so obtaining null is expected behavior
  let tickResult = hubContract.getTick(convertPoolIdToBytes(tick.poolId), tick.tierId, tick.tickIdx)
  let liquidityLower = decodeLiquidityD8(tickResult.liquidityLowerD8)
  let liquidityUpper = decodeLiquidityD8(tickResult.liquidityUpperD8)
  tick.liquidityNet = liquidityLower.minus(liquidityUpper)
  tick.liquidityGross = liquidityLower.abs().plus(liquidityUpper.abs())
  tick.feeGrowthOutside0X64 = tickResult.feeGrowthOutside0
  tick.feeGrowthOutside1X64 = tickResult.feeGrowthOutside1
  tick.save()

  updateTickDayData(tick, event)
}

export function loadTickUpdateFeeVarsAndSave(tier: Tier, tickId: i32, event: ethereum.Event): void {
  let tick = Tick.load(getTickIdWithTierEntityId(tier.id, tickId))
  if (tick !== null) {
    updateTickFeeVarsAndSave(tick, event)
  }
}
