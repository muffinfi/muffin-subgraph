import { BigInt } from '@graphprotocol/graph-ts'
import { decodeLiquidityD8 } from './index'

export let BASE_LIQUIDITY = decodeLiquidityD8(BigInt.fromI32(100))

export function getTierId(poolId: string, tierId: i32): string {
  return poolId + '#' + tierId.toString()
}

export function sqrtGammaToFeeTier(sqrtGamma: i32): BigInt {
  let sqrtGammaI32 = BigInt.fromI32(sqrtGamma)
  return BigInt.fromI64(10 ** 10)
    .minus(sqrtGammaI32.times(sqrtGammaI32))
    .plus(BigInt.fromI32(10 ** 5 / 2)) // round div
    .div(BigInt.fromI32(10 ** 5))
}
