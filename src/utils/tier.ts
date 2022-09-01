import { BigInt } from '@graphprotocol/graph-ts'
import { Tier } from '../types/schema'
import { decodeLiquidityD8 } from './index'

export let BASE_LIQUIDITY = decodeLiquidityD8(BigInt.fromI32(100))

export class ParsedTierId {
  poolId: string
  tierId: i32

  constructor(tierId: string) {
    const split = tierId.split('#')
    assert(split.length === 2, 'Invalid tierId: ' + tierId)
    this.poolId = split[0]
    this.tierId = I32.parseInt(split[1])
  }
}

export function getTierId(poolId: string, tierId: i32): string {
  return poolId + '#' + tierId.toString()
}

export function sqrtGammaToFeeTier(sqrtGamma: i32): i32 {
  let sqrtGammaI32 = BigInt.fromI32(sqrtGamma)
  return BigInt.fromI64(10 ** 10)
    .minus(sqrtGammaI32.times(sqrtGammaI32))
    .plus(BigInt.fromI32(10 ** 5 / 2)) // round div
    .div(BigInt.fromI32(10 ** 5))
    .toI32()
}

export function updateNextTick(tier: Tier, newTick: i32): void {
  if (newTick <= tier.tick) {
    if (newTick > tier.nextTickBelow) {
      tier.nextTickBelow = newTick
    }
  } else {
    if (newTick < tier.nextTickAbove) {
      tier.nextTickAbove = newTick
    }
  }
}
