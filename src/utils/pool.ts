import { Address, ByteArray, Bytes, crypto, ethereum } from '@graphprotocol/graph-ts'
import { Pool } from '../types/schema'

export function getPoolId(token0: Address, token1: Address): string {
  let addresses = [ethereum.Value.fromAddress(token0), ethereum.Value.fromAddress(token1)]
  let tuple = changetype<ethereum.Tuple>(addresses)
  let encoded = ethereum.encode(ethereum.Value.fromTuple(tuple))!
  return crypto.keccak256(encoded).toHexString()
}

export function getPool(token0: Address, token1: Address): Pool | null {
  return Pool.load(getPoolId(token0, token1))
}

export function convertPoolIdToBytes(poolId: string): Bytes {
  return Bytes.fromByteArray(ByteArray.fromHexString(poolId))
}
