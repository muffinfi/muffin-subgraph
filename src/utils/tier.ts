import { BigInt } from '@graphprotocol/graph-ts'
import { decodeLiquidityD8 } from './index'

export let BASE_LIQUIDITY = decodeLiquidityD8(BigInt.fromI32(100))

export function getTierId(poolId: string, tierId: i32): string {
  return poolId + '#' + tierId.toString()
}
