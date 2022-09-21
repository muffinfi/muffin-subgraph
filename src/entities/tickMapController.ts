import { TickMapBlock, TickMapBlockMap, TickMapWord } from '../types/schema'
import { ONE_BI, ZERO_BI } from '../utils/constants'
import { getTickMapBlockId, getTickMapWordId, getTierId } from '../utils/id'
import { MAX_UINT256, MIN_TICK_IDX, mostSignificantBit } from '../utils/math'
import { loadOrCreateBlock, loadOrCreateBlockMap, loadOrCreateWord } from './tickMap'

export class TickMapController {
  tierDBId: string
  blockMap: TickMapBlockMap | null
  blocks: Map<i32, TickMapBlock>
  words: Map<i32, TickMapWord>
  updatedBlockMap: boolean
  updatedBlocks: Map<i32, boolean>
  updatedWords: Map<i32, boolean>

  constructor(poolId: string, tierId: i32) {
    this.tierDBId = getTierId(poolId, tierId)
    this.blockMap = null
    this.blocks = new Map<i32, TickMapBlock>()
    this.words = new Map<i32, TickMapWord>()
    this.updatedBlockMap = false
    this.updatedBlocks = new Map<i32, boolean>()
    this.updatedWords = new Map<i32, boolean>()
  }

  getWord(wordIdx: i32): TickMapWord {
    if (!this.words.has(wordIdx)) {
      this.words.set(wordIdx, loadOrCreateWord(this.tierDBId, wordIdx))
    }
    return this.words.get(wordIdx)
  }

  getBlock(blockIdx: i32): TickMapBlock {
    if (!this.blocks.has(blockIdx)) {
      this.blocks.set(blockIdx, loadOrCreateBlock(this.tierDBId, blockIdx))
    }
    return this.blocks.get(blockIdx)
  }

  getBlockMap(): TickMapBlockMap {
    if (!this.blockMap) {
      this.blockMap = loadOrCreateBlockMap(this.tierDBId)
    }
    return this.blockMap!
  }

  try_getWord(wordIdx: i32): TickMapWord | null {
    let word: TickMapWord | null = null
    if (this.words.has(wordIdx)) {
      word = this.words.get(wordIdx)
    } else {
      word = TickMapWord.load(getTickMapWordId(this.tierDBId, wordIdx))
      if (word) {
        this.words.set(wordIdx, word)
      }
    }
    return word
  }

  try_getBlock(blockIdx: i32): TickMapBlock | null {
    let block: TickMapBlock | null = null
    if (this.blocks.has(blockIdx)) {
      block = this.blocks.get(blockIdx)
    } else {
      block = TickMapBlock.load(getTickMapBlockId(this.tierDBId, blockIdx))
      if (block) {
        this.blocks.set(blockIdx, block)
      }
    }
    return block
  }

  try_getBlockMap(): TickMapBlockMap | null {
    if (!this.blockMap) {
      this.blockMap = TickMapBlockMap.load(this.tierDBId)
    }
    return this.blockMap
  }

  set(tickIdx: i32): void {
    const compressed = tickIdx - MIN_TICK_IDX
    const blockIdx = compressed >> 16
    const wordIdx = compressed >> 8

    const word = this.getWord(wordIdx)
    word.data = word.data.bitOr(ONE_BI.leftShift((compressed & 0xff) as u8))
    this.updatedWords.set(word.index, true)

    const block = this.getBlock(blockIdx)
    block.data = block.data.bitOr(ONE_BI.leftShift((wordIdx & 0xff) as u8))
    this.updatedBlocks.set(block.index, true)

    const blockMap = this.getBlockMap()
    blockMap.data = blockMap.data.bitOr(ONE_BI.leftShift(blockIdx as u8))
    this.updatedBlockMap = true
  }

  unset(tickIdx: i32): void {
    const compressed = tickIdx - MIN_TICK_IDX
    const wordIdx = compressed >> 8
    const blockIdx = compressed >> 16

    const word = this.getWord(wordIdx)
    word.data = word.data.bitAnd(MAX_UINT256.minus(ONE_BI.leftShift((compressed & 0xff) as u8)))
    this.updatedWords.set(word.index, true)

    if (word.data.isZero()) {
      const block = this.getBlock(blockIdx)
      block.data = block.data.bitAnd(MAX_UINT256.minus(ONE_BI.leftShift((wordIdx & 0xff) as u8)))
      this.updatedBlocks.set(block.index, true)

      if (block.data.isZero()) {
        const blockMap = this.getBlockMap()
        blockMap.data = blockMap.data.bitAnd(MAX_UINT256.minus(ONE_BI.leftShift(blockIdx as u8)))
        this.updatedBlockMap = true
      }
    }
  }

  save(): void {
    if (this.updatedBlockMap) {
      this.getBlockMap().save()
      this.updatedBlockMap = false
    }

    let keys = this.updatedBlocks.keys()
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (this.updatedBlocks.get(key)) {
        this.blocks.get(key).save()
      }
    }
    this.updatedBlocks.clear()

    keys = this.updatedWords.keys()
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (this.updatedWords.get(key)) {
        this.words.get(key).save()
      }
    }
    this.updatedWords.clear()
  }

  findNextBelow(tickIdx: i32): i32 {
    let compressed = tickIdx - MIN_TICK_IDX
    let wordIdx = compressed >> 8
    let blockIdx = compressed >> 16

    const word = this.try_getWord(wordIdx)
    let wordData = (word ? word.data : ZERO_BI).bitAnd(ONE_BI.leftShift((compressed & 0xff) as u8).minus(ONE_BI))

    if (wordData.isZero()) {
      const block = this.try_getBlock(blockIdx)
      let blockData = (block ? block.data : ZERO_BI).bitAnd(ONE_BI.leftShift((wordIdx & 0xff) as u8).minus(ONE_BI))

      if (blockData.isZero()) {
        const blockMap = this.try_getBlockMap()
        let blockMapData = (blockMap ? blockMap.data : ZERO_BI).bitAnd(ONE_BI.leftShift(blockIdx as u8).minus(ONE_BI))
        assert(!blockMapData.isZero(), 'impossible block map data')

        blockIdx = mostSignificantBit(blockMapData)
        blockData = this.getBlock(blockIdx).data
      }

      wordIdx = (blockIdx << 8) | mostSignificantBit(blockData)
      wordData = this.getWord(wordIdx).data
    }

    compressed = (wordIdx << 8) | mostSignificantBit(wordData)
    return compressed + MIN_TICK_IDX
  }
}
