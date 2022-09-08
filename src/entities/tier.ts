import { BigInt } from '@graphprotocol/graph-ts'
import { Tier } from '../types/schema'
import { sqrtPriceX72ToTick } from '../utils/math'
import { decodeLiquidityD8 } from '../utils/misc'

export const BASE_LIQUIDITY = decodeLiquidityD8(BigInt.fromI32(100))

export function getTierTickIdx(sqrtPrice: BigInt, nextTickAbove: i32): i32 {
  const tickIdx = sqrtPriceX72ToTick(sqrtPrice)
  if (nextTickAbove == tickIdx) return tickIdx - 1
  return tickIdx
}

const E10: i64 = 10 ** 10
const E5: i64 = 10 ** 5
export function sqrtGammaToFeeTier(sqrtGamma: i32): i32 {
  return ((E10 - (sqrtGamma as i64) ** 2 + E5 / 2) / E5) as i32
}

function updateTierNextTick(tier: Tier, tickIdxCurrent: i32, tickNew: i32): boolean {
  if (tickNew <= tickIdxCurrent) {
    if (tickNew > tier.nextTickBelow) {
      tier.nextTickBelow = tickNew
      return true
    }
  } else {
    if (tickNew < tier.nextTickAbove) {
      tier.nextTickAbove = tickNew
      return true
    }
  }
  return false
}

export function updateTierNextTicks(tier: Tier, tickIdxCurrent: i32, tickIdxLower: i32, tickIdxUpper: i32): boolean {
  const changed1 = updateTierNextTick(tier, tickIdxCurrent, tickIdxLower)
  const changed2 = updateTierNextTick(tier, tickIdxCurrent, tickIdxUpper)
  return changed1 || changed2
}
