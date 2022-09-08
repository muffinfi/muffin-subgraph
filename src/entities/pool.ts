import { Address } from '@graphprotocol/graph-ts'
import { Pool } from '../types/schema'
import { getPoolId } from '../utils/id'

export function getPool(token0: Address, token1: Address): Pool | null {
  return Pool.load(getPoolId(token0, token1))
}
