import { Address, BigInt, ethereum, store } from '@graphprotocol/graph-ts'
import { HubPosition, Tick, Tier } from '../types/schema'
import { ONE_FOR_ZERO, ZERO_BI, ZERO_FOR_ONE } from '../utils/constants'
import { getTickId } from '../utils/id'
import { loadOrCreateHubPosition } from './hubPosition'
import { createTick, updateTickFeeVarsAndSave } from './tick'
import { TickMapController } from './tickMapController'
import { getTierTickIdx, updateTierNextTicks } from './tier'

export class TickController {
  poolId: string
  tierId: i32
  tickMap: TickMapController
  ethBlock: ethereum.Block
  ticks: Map<i32, Tick>
  updatedTicks: Map<i32, boolean>

  constructor(poolId: string, tierId: i32, ethBlock: ethereum.Block) {
    this.poolId = poolId
    this.tierId = tierId
    this.tickMap = new TickMapController(poolId, tierId)
    this.ethBlock = ethBlock
    this.ticks = new Map<i32, Tick>()
    this.updatedTicks = new Map<i32, boolean>()
  }

  getTick(tickIdx: i32): Tick {
    if (!this.ticks.has(tickIdx)) {
      let tick = Tick.load(getTickId(this.poolId, this.tierId, tickIdx))
      if (!tick) {
        tick = createTick(this.poolId, this.tierId, tickIdx, this.ethBlock)
      }
      this.ticks.set(tickIdx, tick)
    }
    return this.ticks.get(tickIdx)
  }

  try_getTick(tickIdx: i32): Tick | null {
    let tick: Tick | null = null
    if (this.ticks.has(tickIdx)) {
      tick = this.ticks.get(tickIdx)
    } else {
      tick = Tick.load(getTickId(this.poolId, this.tierId, tickIdx))
      if (tick) {
        this.ticks.set(tickIdx, tick)
      }
    }
    return tick
  }

  flagUpdated(tickIdx: i32): void {
    this.updatedTicks.set(tickIdx, true)
  }

  insertTickToLinkedList(tick: Tick): void {
    const tickBelow = this.getTick(this.tickMap.findNextBelow(tick.tickIdx))
    const tickAbove = this.getTick(tickBelow.nextAbove)

    tickBelow.nextAbove = tick.tickIdx
    tickAbove.nextBelow = tick.tickIdx
    this.flagUpdated(tickBelow.tickIdx)
    this.flagUpdated(tickAbove.tickIdx)
    this.tickMap.set(tick.tickIdx)

    tick.nextBelow = tickBelow.tickIdx
    tick.nextAbove = tickAbove.tickIdx
  }

  updateTick(tier: Tier, tierTickIdx: i32, tickIdx: i32, liquidityDelta: BigInt, isLowerTick: boolean): Tick {
    let tick = this.try_getTick(tickIdx)

    if (tick === null || tick.liquidityGross.isZero()) {
      const newTick = createTick(this.poolId, this.tierId, tickIdx, this.ethBlock)
      if (tick) {
        newTick.createdAtTimestamp = tick.createdAtTimestamp
        newTick.createdAtBlockNumber = tick.createdAtBlockNumber
      }
      this.ticks.set(tickIdx, newTick)
      tick = newTick

      if (liquidityDelta.gt(ZERO_BI)) {
        this.insertTickToLinkedList(tick)
      }

      if (tick.tickIdx <= tierTickIdx) {
        tick.feeGrowthOutside0X64 = tier.feeGrowthGlobal0X64
        tick.feeGrowthOutside1X64 = tier.feeGrowthGlobal1X64
      }
    }

    tick.liquidityNet = isLowerTick ? tick.liquidityNet.plus(liquidityDelta) : tick.liquidityNet.minus(liquidityDelta)
    tick.liquidityGross = tick.liquidityGross.plus(liquidityDelta)
    this.flagUpdated(tickIdx)

    return tick
  }

  updateLimitOrderData(tickIdxLower: i32, tickIdxUpper: i32, direction: i32, liquidityDelta: BigInt): void {
    const tick = this.getTick(direction == ZERO_FOR_ONE ? tickIdxUpper : tickIdxLower)
    const spacing = tickIdxUpper - tickIdxLower
    if (direction == ZERO_FOR_ONE) {
      tick.limitOrderLiquidity0For1 = tick.limitOrderLiquidity0For1.plus(liquidityDelta)
      tick.limitOrderTickSpacing0For1 = tick.limitOrderLiquidity0For1.isZero() ? 0 : spacing
    }
    if (direction == ONE_FOR_ZERO) {
      tick.limitOrderLiquidity1For0 = tick.limitOrderLiquidity1For0.plus(liquidityDelta)
      tick.limitOrderTickSpacing1For0 = tick.limitOrderLiquidity1For0.isZero() ? 0 : spacing
    }
    this.flagUpdated(tick.tickIdx)
  }

  deleteTickIfEmpty(tick_probablyOutdated: Tick): boolean {
    if (!tick_probablyOutdated.liquidityGross.isZero()) return false
    const tick = this.getTick(tick_probablyOutdated.tickIdx)

    // remove from linked list
    const tickBelow = this.getTick(tick.nextBelow)
    const tickAbove = this.getTick(tick.nextAbove)

    tickBelow.nextAbove = tick.nextAbove
    tickAbove.nextBelow = tick.nextBelow
    this.flagUpdated(tickBelow.tickIdx)
    this.flagUpdated(tickAbove.tickIdx)
    this.tickMap.unset(tick.tickIdx)

    // remove tick from db entirely
    this.flagUpdated(tick.tickIdx)
    return true
  }

  resetTierNextTicks(tier: Tier, tickIdxCurrent: i32): void {
    const idxBelow = this.tickMap.findNextBelow(tickIdxCurrent + 1)
    const tickBelow = this.getTick(idxBelow)
    tier.nextTickBelow = tickBelow.tickIdx
    tier.nextTickAbove = tickBelow.nextAbove
  }

  /**
   * Update tier's liquidity, ticks, position, and cleanup ticks if needed
   * @returns HubPosition
   */
  handleMintOrBurnAndGetHubPosition(
    tier: Tier,
    tickIdxLower: i32,
    tickIdxUpper: i32,
    liquidityDelta: BigInt,
    owner: Address,
    positionRefId: BigInt,
    token0Id: string,
    token1Id: string
  ): HubPosition {
    // --- update tier's liquidity ---
    const tierTickIdx = getTierTickIdx(tier.sqrtPrice, tier.nextTickAbove)
    if (tickIdxLower <= tierTickIdx && tierTickIdx < tickIdxUpper) {
      tier.liquidity = tier.liquidity.plus(liquidityDelta)
    }

    // --- update ticks ---
    const tickLower = this.updateTick(tier, tierTickIdx, tickIdxLower, liquidityDelta, true)
    const tickUpper = this.updateTick(tier, tierTickIdx, tickIdxUpper, liquidityDelta, false)
    updateTierNextTicks(tier, tierTickIdx, tickLower.tickIdx, tickUpper.tickIdx)

    // --- update position ---
    const position = loadOrCreateHubPosition(
      this.poolId,
      owner,
      positionRefId,
      this.tierId,
      tickIdxLower,
      tickIdxUpper,
      token0Id,
      token1Id
    )
    position.liquidity = position.liquidity.plus(liquidityDelta)
    if (position.limitOrderType != 0) {
      this.updateLimitOrderData(position.tickLower, position.tickUpper, position.limitOrderType, liquidityDelta)
      if (position.liquidity.isZero()) position.limitOrderType = 0
    }

    // --- cleanup ticks ---
    if (liquidityDelta.lt(ZERO_BI)) {
      const deleted1 = this.deleteTickIfEmpty(tickLower)
      const deleted2 = this.deleteTickIfEmpty(tickUpper)
      if (deleted1 || deleted2) this.resetTierNextTicks(tier, tierTickIdx)
    }

    return position
  }

  settle(tickEnd: Tick, direction: i32, tier: Tier): void {
    if (direction == ZERO_FOR_ONE && tickEnd.limitOrderTickSpacing0For1 == 0) return
    if (direction == ONE_FOR_ZERO && tickEnd.limitOrderTickSpacing1For0 == 0) return

    const tickStart = this.getTick(
      direction == ZERO_FOR_ONE
        ? tickEnd.tickIdx - tickEnd.limitOrderTickSpacing0For1
        : tickEnd.tickIdx + tickEnd.limitOrderTickSpacing1For0
    )

    {
      // price up
      if (direction == ZERO_FOR_ONE) {
        const liquidityToSettle = tickEnd.limitOrderLiquidity0For1

        tickStart.liquidityGross = tickStart.liquidityGross.minus(liquidityToSettle)
        tickStart.liquidityNet = tickStart.liquidityNet.minus(liquidityToSettle)
        this.flagUpdated(tickStart.tickIdx)

        tickEnd.liquidityGross = tickEnd.liquidityGross.minus(liquidityToSettle)
        tickEnd.liquidityNet = tickEnd.liquidityNet.plus(liquidityToSettle)
        tickEnd.limitOrderLiquidity0For1 = ZERO_BI
        tickEnd.limitOrderTickSpacing0For1 = 0
        this.flagUpdated(tickEnd.tickIdx)
      }

      // price down
      if (direction == ONE_FOR_ZERO) {
        const liquidityToSettle = tickEnd.limitOrderLiquidity1For0

        tickStart.liquidityGross = tickStart.liquidityGross.minus(liquidityToSettle)
        tickStart.liquidityNet = tickStart.liquidityNet.plus(liquidityToSettle)
        this.flagUpdated(tickStart.tickIdx)

        tickEnd.liquidityGross = tickEnd.liquidityGross.minus(liquidityToSettle)
        tickEnd.liquidityNet = tickEnd.liquidityNet.minus(liquidityToSettle)
        tickEnd.limitOrderLiquidity1For0 = ZERO_BI
        tickEnd.limitOrderTickSpacing1For0 = 0
        this.flagUpdated(tickEnd.tickIdx)
      }
    }

    if (tickStart.liquidityGross.isZero()) {
      const tickBelow = this.getTick(tickStart.nextBelow)
      const tickAbove = this.getTick(tickStart.nextAbove)
      tickBelow.nextAbove = tickStart.nextAbove
      tickAbove.nextBelow = tickStart.nextBelow
      this.flagUpdated(tickBelow.tickIdx)
      this.flagUpdated(tickAbove.tickIdx)
      this.flagUpdated(tickStart.tickIdx)
      this.tickMap.unset(tickStart.tickIdx)
    }

    if (tickEnd.liquidityGross.isZero()) {
      // need to reload tickEnd if tickStart is cleared, since tickEnd.next{Below/Above} may be changed
      const tickEnd_ = tickStart.liquidityGross.isZero() ? this.getTick(tickEnd.tickIdx) : tickEnd

      const tickBelow = this.getTick(tickEnd_.nextBelow)
      const tickAbove = this.getTick(tickEnd_.nextAbove)
      tickBelow.nextAbove = tickEnd_.nextAbove
      tickAbove.nextBelow = tickEnd_.nextBelow
      this.flagUpdated(tickBelow.tickIdx)
      this.flagUpdated(tickAbove.tickIdx)
      this.flagUpdated(tickEnd_.tickIdx)
      this.tickMap.unset(tickEnd_.tickIdx)

      //
      tier.nextTickBelow = tickBelow.tickIdx
      tier.nextTickAbove = tickAbove.tickIdx
    }
  }

  save(): void {
    const keys = this.updatedTicks.keys()
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (!this.updatedTicks.get(key)) continue
      const tick = this.ticks.get(key)
      if (tick.liquidityGross.isZero()) {
        store.remove('Tick', tick.id)
      } else {
        tick.save()
      }
    }
    this.updatedTicks.clear()
    this.tickMap.save()
  }

  /**
   * Update fee vars from chain and save tick
   * @returns updated from chain count
   */
  updateTickFeeVarsAndSave(maxUpdateCount: i32): i32 {
    const keys = this.updatedTicks.keys()
    let updated = 0
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (!this.updatedTicks.get(key)) continue
      const tick = this.ticks.get(key)
      if (tick.liquidityGross.isZero()) {
        store.remove('Tick', tick.id)
      } else if (updated < maxUpdateCount) {
        updateTickFeeVarsAndSave(tick)
        updated += 1
      } else {
        tick.save()
      }
    }
    this.updatedTicks.clear()
    this.tickMap.save()

    return updated
  }
}
