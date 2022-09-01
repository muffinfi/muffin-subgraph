import { BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { Tick, Tier } from '../types/schema'
import { hubContract, ONE_BD, ONE_FOR_ZERO, ZERO_BI } from './constants'
import { bigDecimalExponated, decodeLiquidityD8, safeDiv } from './index'
import { updateTickDayData } from './intervalUpdates'
import { convertPoolIdToBytes } from './pool'
import { getTierId } from './tier'

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
  // tick.limitOrderSpacingZeroForOne = 0
  // tick.limitOrderSpacingOneForZero = 0
  tick.nextTickIdxAbove = 0
  tick.nextTickIdxBelow = 0

  return tick
}

export function updateTierNextTick(tier: Tier, newTick: i32): void {
  if (newTick <= tier.tick) {
    let nextTickBelow = tier.nextTickBelow
    if (newTick > nextTickBelow) {
      let previousTick = Tick.load(getTickIdWithTierEntityId(tier.id, nextTickBelow))!
      previousTick
      tier.nextTickBelow = newTick
    }
  } else {
    if (newTick < tier.nextTickAbove) {
      tier.nextTickAbove = newTick
    }
  }
}

export function fetchChainTick(poolId: string, tierId: i32, tickIdx: i32): Tick {
  let tickResult = hubContract.getTick(convertPoolIdToBytes(poolId), tierId, tickIdx)
  let tick = new Tick('') // make it unable to save
  let liquidityLower = decodeLiquidityD8(tickResult.liquidityLowerD8)
  let liquidityUpper = decodeLiquidityD8(tickResult.liquidityUpperD8)
  tick.liquidityNet = liquidityLower.minus(liquidityUpper)
  tick.liquidityGross = liquidityLower.abs().plus(liquidityUpper.abs())
  tick.feeGrowthOutside0X64 = tickResult.feeGrowthOutside0
  tick.feeGrowthOutside1X64 = tickResult.feeGrowthOutside1
  tick.nextTickIdxAbove = tickResult.nextAbove
  tick.nextTickIdxBelow = tickResult.nextBelow
  return tick
}

export function mergeWithOnChainTickAndSave(tick: Tick, onChainTick: Tick, event: ethereum.Event): void {
  tick.liquidityNet = onChainTick.liquidityNet
  tick.liquidityGross = onChainTick.liquidityGross
  tick.feeGrowthOutside0X64 = onChainTick.feeGrowthOutside0X64
  tick.feeGrowthOutside1X64 = onChainTick.feeGrowthOutside1X64
  tick.nextTickIdxAbove = onChainTick.nextTickIdxAbove
  tick.nextTickIdxBelow = onChainTick.nextTickIdxBelow
  tick.save()

  updateTickDayData(tick, event)
}

export function updateTickFeeVarsAndSave(tick: Tick, event: ethereum.Event): void {
  // not all ticks are initialized so obtaining null is expected behavior
  let onChainTick = fetchChainTick(tick.poolId, tick.tierId, tick.tickIdx)
  mergeWithOnChainTickAndSave(tick, onChainTick, event)
}

export function unsetTickAndGetNextTick(tierId: string, tickId: i32, limitOrderType: i8, event: ethereum.Event): i32 {
  let tick = Tick.load(getTickIdWithTierEntityId(tierId, tickId))!
  let oldNextTick = limitOrderType === ONE_FOR_ZERO ? tick.nextTickIdxAbove : tick.nextTickIdxBelow
  tick.liquidityNet = ZERO_BI
  tick.liquidityGross = ZERO_BI
  tick.nextTickIdxAbove = 0
  tick.nextTickIdxBelow = 0
  tick.save()

  updateTickDayData(tick, event)

  return oldNextTick
}

export function loadTickUpdateFeeVarsAndSave(tier: Tier, tickIdx: i32, event: ethereum.Event): void {
  let tick = Tick.load(getTickIdWithTierEntityId(tier.id, tickIdx))
  if (tick !== null) {
    updateTickFeeVarsAndSave(tick, event)
  }
}

// export function updateLimitOrderStartTick(tier: Tier, tick: Tick, limitOrderType: i8, event: ethereum.Event): void {
//   if (limitOrderType === ZERO_FOR_ONE && tick.limitOrderSpacingZeroForOne !== 0) {
//     let startTick = Tick.load(getTickIdWithTierEntityId(tier.id, tick.tickIdx + tick.limitOrderSpacingZeroForOne))
//     if (startTick !== null) {
//       updateTickFeeVarsAndSave(startTick, event)
//       tick.limitOrderSpacingZeroForOne = 0
//     }
//   } else if (limitOrderType === ONE_FOR_ZERO && tick.limitOrderSpacingOneForZero !== 0) {
//     let startTick = Tick.load(getTickIdWithTierEntityId(tier.id, tick.tickIdx - tick.limitOrderSpacingOneForZero))
//     if (startTick !== null) {
//       updateTickFeeVarsAndSave(startTick, event)
//       tick.limitOrderSpacingOneForZero = 0
//     }
//   }
// }

export function updateTickNextTickAndSave(
  tierId: string,
  tickIdx: i32,
  tickLower: i32,
  tickUpper: i32,
  event: ethereum.Event
): void {
  let tick = Tick.load(getTickIdWithTierEntityId(tierId, tickIdx))!
  let updated = false

  if (tick.tickIdx < tickUpper) {
    let oldAbove = tick.nextTickIdxAbove
    tick.nextTickIdxAbove =
      tick.tickIdx > tickLower ? min(tickUpper, tick.nextTickIdxAbove) : min(tickLower, tick.nextTickIdxAbove)
    updated = tick.nextTickIdxAbove !== oldAbove
  } else if (tick.tickIdx > tickLower) {
    let oldBelow = tick.nextTickIdxBelow
    tick.nextTickIdxBelow =
      tick.tickIdx > tickUpper ? max(tickUpper, tick.nextTickIdxBelow) : max(tickLower, tick.nextTickIdxBelow)
    updated = updated || tick.nextTickIdxBelow !== oldBelow
  }

  if (updated) {
    tick.save()
    updateTickDayData(tick, event)
  }
}
