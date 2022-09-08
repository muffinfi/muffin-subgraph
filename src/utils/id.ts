import { Address, BigInt, ByteArray, Bytes, crypto, ethereum } from '@graphprotocol/graph-ts'

// Hub position
export function getHubPositionId(
  poolId: string,
  owner: Address,
  positionRefId: BigInt,
  tierId: i32,
  tickIdxLower: i32,
  tickIdxUpper: i32
): string {
  return (
    poolId +
    '_' +
    owner.toHexString() +
    '_' +
    tierId.toString() +
    '_' +
    tickIdxLower.toString() +
    '_' +
    tickIdxUpper.toString() +
    '_' +
    positionRefId.toString()
  )
}

// Pool
export function getPoolId(token0: Address, token1: Address): string {
  const addresses = [ethereum.Value.fromAddress(token0), ethereum.Value.fromAddress(token1)]
  const tuple = changetype<ethereum.Tuple>(addresses)
  const encoded = ethereum.encode(ethereum.Value.fromTuple(tuple))!
  return crypto.keccak256(encoded).toHexString()
}

export function convertPoolIdToBytes(poolId: string): Bytes {
  return Bytes.fromByteArray(ByteArray.fromHexString(poolId))
}

// Tier
export function getTierId(poolId: string, tierId: i32): string {
  return poolId + '#' + tierId.toString()
}

// Tick
export function getTickIdWithTierEntityId(tierId: string, tickIdx: i32): string {
  return tierId + '#' + tickIdx.toString()
}

export function getTickId(poolId: string, tierId: i32, tickIdx: i32): string {
  return getTickIdWithTierEntityId(getTierId(poolId, tierId), tickIdx)
}

// TickMap
export function getTickMapWordId(tierDBId: string, wordIdx: i32): string {
  return tierDBId + '#' + wordIdx.toString()
}

export function getTickMapBlockId(tierDBId: string, blockIdx: i32): string {
  return tierDBId + '#' + blockIdx.toString()
}
