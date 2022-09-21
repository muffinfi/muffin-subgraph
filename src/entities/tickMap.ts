import { TickMapBlock, TickMapBlockMap, TickMapWord } from '../types/schema'
import { ZERO_BI } from '../utils/constants'
import { getTickMapBlockId, getTickMapWordId } from '../utils/id'

export function loadOrCreateWord(tierDBId: string, wordIdx: i32): TickMapWord {
  const id = getTickMapWordId(tierDBId, wordIdx)
  let x = TickMapWord.load(id)
  if (!x) {
    x = new TickMapWord(id)
    x.tier = tierDBId
    x.index = wordIdx
    x.data = ZERO_BI
  }
  return x
}

export function loadOrCreateBlock(tierDBId: string, blockIdx: i32): TickMapBlock {
  const id = getTickMapBlockId(tierDBId, blockIdx)
  let x = TickMapBlock.load(id)
  if (!x) {
    x = new TickMapBlock(id)
    x.tier = tierDBId
    x.index = blockIdx
    x.data = ZERO_BI
  }
  return x
}

export function loadOrCreateBlockMap(tierDBId: string): TickMapBlockMap {
  let x = TickMapBlockMap.load(tierDBId)
  if (!x) {
    x = new TickMapBlockMap(tierDBId)
    x.tier = tierDBId
    x.data = ZERO_BI
  }
  return x
}
