import { BigDecimal, BigInt, log } from '@graphprotocol/graph-ts'
import {
  Burn as BurnEvent,
  CollectSettled as CollectSettledEvent,
  Deposit,
  Mint as MintEvent,
  PoolCreated,
  SetLimitOrderType,
  Swap as SwapEvent,
  UpdateDefaultParameters,
  UpdatePool,
  UpdateTier,
  Withdraw,
} from '../types/Hub/Hub'
import { Bundle, Burn, CollectSettled, Hub, Mint, Pool, Swap, SwapTierData, Tick, Tier, Token } from '../types/schema'
import {
  ceilDiv,
  convertTokenToDecimal,
  decodeLiquidityD8,
  decodeTierData,
  extractAmountDistributionAtIndex,
  getOrCreateHub,
  loadTransaction,
  safeDiv,
} from '../utils'
import { getAccountTokenBalance, updateAndSaveTokenBalance } from '../utils/accountTokenBalance'
import { hubContract, HUB_ADDRESS, ONE_BI, WHITELIST_TOKENS, ZERO_BD, ZERO_BI } from '../utils/constants'
import {
  updateMuffinDayData,
  updatePoolDayData,
  updatePoolHourData,
  updateTierDayData,
  updateTierHourData,
  updateTokenDayData,
  updateTokenHourData,
} from '../utils/intervalUpdates'
import { MAX_TICK_IDX, MIN_TICK_IDX } from '../utils/math'
import { convertPoolIdToBytes } from '../utils/pool'
import { findEthPerToken, getEthPriceInUSD, getTrackedAmountUSD, sqrtPriceX72ToTokenPrices } from '../utils/pricing'
import {
  createTick,
  getTickId,
  getTickIdWithTierEntityId,
  loadTickUpdateFeeVarsAndSave,
  updateTickFeeVarsAndSave,
} from '../utils/tick'
import { BASE_LIQUIDITY, getTierId, sqrtGammaToFeeTier } from '../utils/tier'
import { getOrCreateToken } from '../utils/token'
import {
  handleDecreaseLiquidity,
  handleIncreaseLiquidity,
  handleSetLimitOrderType as handleManagerSetLimitOrderType,
} from './manager'

export function handleUpdateDefaultParameters(event: UpdateDefaultParameters): void {
  let hub = getOrCreateHub()
  hub.defaultTickSpacing = event.params.tickSpacing
  hub.defaultProtocolFee = event.params.protocolFee
  hub.save()
}

export function handlePoolCreated(event: PoolCreated): void {
  let hub = getOrCreateHub()
  hub.poolCount = hub.poolCount.plus(ONE_BI)
  hub.save()

  let token0 = getOrCreateToken(event.params.token0)
  let token1 = getOrCreateToken(event.params.token1)
  let poolId = event.params.poolId.toHexString()
  let pool = new Pool(poolId)

  if (token0 === null) {
    log.debug('token 0 is null', [])
    return
  }

  if (token1 === null) {
    log.debug('token 1 is null', [])
    return
  }

  // update white listed pools
  if (WHITELIST_TOKENS.includes(token0.id)) {
    let newPools = token1.whitelistPools
    newPools.push(pool.id)
    token1.whitelistPools = newPools
  }
  if (WHITELIST_TOKENS.includes(token1.id)) {
    let newPools = token0.whitelistPools
    newPools.push(pool.id)
    token0.whitelistPools = newPools
  }

  token0.save()
  token1.save()

  pool.token0 = token0.id
  pool.token1 = token1.id
  pool.createdAtTimestamp = event.block.timestamp
  pool.createdAtBlockNumber = event.block.number
  pool.liquidityProviderCount = ZERO_BI
  pool.txCount = ZERO_BI
  pool.liquidity = ZERO_BI
  pool.tickSpacing = hub.defaultTickSpacing // incorrect if pool has specifc default. however, it'll be updated with eth_call below.
  pool.protocolFee = hub.defaultProtocolFee
  pool.amount0 = ZERO_BD
  pool.amount1 = ZERO_BD
  pool.totalValueLockedUSD = ZERO_BD
  pool.totalValueLockedETH = ZERO_BD
  pool.totalValueLockedUSDUntracked = ZERO_BD
  pool.volumeToken0 = ZERO_BD
  pool.volumeToken1 = ZERO_BD
  pool.volumeUSD = ZERO_BD
  pool.feesUSD = ZERO_BD
  pool.untrackedVolumeUSD = ZERO_BD
  pool.collectedFeesToken0 = ZERO_BD
  pool.collectedFeesToken1 = ZERO_BD
  pool.collectedFeesUSD = ZERO_BD
  pool.tierIds = []

  let params = hubContract.getPoolParameters(convertPoolIdToBytes(pool.id))
  pool.tickSpacing = params.value0
  pool.protocolFee = params.value1
  pool.save()
}

export function handleUpdatePool(event: UpdatePool): void {
  let pool = Pool.load(event.params.poolId.toHexString())!
  pool.tickSpacing = event.params.tickSpacing
  pool.protocolFee = event.params.protocolFee
  pool.save()
}

export function handleUpdateTier(event: UpdateTier): void {
  let pool = Pool.load(event.params.poolId.toHexString())!
  let tierId = getTierId(pool.id, event.params.tierId)
  let tier = Tier.load(tierId)
  let isNew = false

  if (!tier) {
    isNew = true

    tier = new Tier(tierId)
    tier.createdAtTimestamp = event.block.timestamp
    tier.createdAtBlockNumber = event.block.number
    tier.pool = pool.id
    tier.poolId = pool.id
    tier.token0 = pool.token0
    tier.token1 = pool.token1

    tier.token0Price = ZERO_BD
    tier.token1Price = ZERO_BD
    tier.liquidityProviderCount = ZERO_BI
    tier.txCount = ZERO_BI
    tier.liquidity = BASE_LIQUIDITY
    tier.sqrtPrice = ZERO_BI
    tier.feeGrowthGlobal0X64 = ZERO_BI
    tier.feeGrowthGlobal1X64 = ZERO_BI
    tier.amount0 = ZERO_BD
    tier.amount1 = ZERO_BD
    tier.totalValueLockedUSD = ZERO_BD
    tier.totalValueLockedETH = ZERO_BD
    tier.totalValueLockedUSDUntracked = ZERO_BD
    tier.volumeToken0 = ZERO_BD
    tier.volumeToken1 = ZERO_BD
    tier.volumeUSD = ZERO_BD
    tier.feesUSD = ZERO_BD
    tier.untrackedVolumeUSD = ZERO_BD
    tier.limitOrderTickSpacingMultiplier = 0
    tier.tick = 0
    tier.nextTickAbove = MAX_TICK_IDX
    tier.nextTickBelow = MIN_TICK_IDX

    tier.collectedFeesToken0 = ZERO_BD
    tier.collectedFeesToken1 = ZERO_BD
    tier.collectedFeesUSD = ZERO_BD
    tier.tierId = event.params.tierId
  }

  tier.sqrtGamma = event.params.sqrtGamma
  tier.feeTier = sqrtGammaToFeeTier(event.params.sqrtGamma)
  tier.limitOrderTickSpacingMultiplier = event.params.limitOrderTickSpacingMultiplier
  tier.save()

  if (!isNew) return

  let minTickId = getTickId(pool.id, tier.tierId, MIN_TICK_IDX)
  let maxTickId = getTickId(pool.id, tier.tierId, MAX_TICK_IDX)
  let minTick = Tick.load(minTickId)
  let maxTick = Tick.load(maxTickId)

  if (minTick === null) {
    minTick = createTick(minTickId, MIN_TICK_IDX, pool.id, tier.tierId, event)
    minTick.liquidityNet = BASE_LIQUIDITY
    minTick.liquidityGross = BASE_LIQUIDITY
    // minTick.nextTickIdxBelow = MIN_TICK_IDX
    // minTick.nextTickIdxAbove = MAX_TICK_IDX
    minTick.save()
  }

  if (maxTick === null) {
    maxTick = createTick(maxTickId, MAX_TICK_IDX, pool.id, tier.tierId, event)
    maxTick.liquidityNet = ZERO_BI.minus(BASE_LIQUIDITY)
    maxTick.liquidityGross = BASE_LIQUIDITY
    maxTick.nextTickIdxBelow = MIN_TICK_IDX
    maxTick.nextTickIdxAbove = MAX_TICK_IDX
    maxTick.save()
  }

  let tierIds = pool.tierIds
  tierIds.push(tier.id)
  pool.tierIds = tierIds

  let hub = Hub.load(HUB_ADDRESS)!
  let bundle = Bundle.load('1')!
  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)!
  let onChainTier = hubContract.getTier(convertPoolIdToBytes(pool.id), event.params.tierId)
  let sqrtPrice = onChainTier.sqrtPrice

  let amount0 = convertTokenToDecimal(ceilDiv(BigInt.fromI32(100).leftShift(72 + 8), sqrtPrice), token0.decimals)
  let amount1 = convertTokenToDecimal(ceilDiv(BigInt.fromI32(100).times(sqrtPrice), ONE_BI.leftShift(72 - 8)), token1.decimals) // prettier-ignore

  // reset tvl aggregates until new amounts calculated
  hub.totalValueLockedETH = hub.totalValueLockedETH.minus(pool.totalValueLockedETH)

  // update token0 data
  token0.amountLocked = token0.amountLocked.plus(amount0)
  token0.totalValueLockedUSD = token0.amountLocked.times(token0.derivedETH.times(bundle.ethPriceUSD))

  // update token1 data
  token1.amountLocked = token1.amountLocked.plus(amount1)
  token1.totalValueLockedUSD = token1.amountLocked.times(token1.derivedETH.times(bundle.ethPriceUSD))

  // init tier
  let prices = sqrtPriceX72ToTokenPrices(sqrtPrice, token0, token1)
  tier.sqrtPrice = sqrtPrice
  tier.token0Price = prices[0] // i.e. token0's price denominated in token1
  tier.token1Price = prices[1] // i.e. token1's price denominated in token0

  tier.tick = onChainTier.tick
  tier.feeGrowthGlobal0X64 = onChainTier.feeGrowthGlobal0
  tier.feeGrowthGlobal1X64 = onChainTier.feeGrowthGlobal1

  tier.amount0 = tier.amount0.plus(amount0)
  tier.amount1 = tier.amount1.plus(amount1)
  tier.totalValueLockedETH = tier.amount0.times(token0.derivedETH).plus(tier.amount1.times(token1.derivedETH))
  tier.totalValueLockedUSD = tier.totalValueLockedETH.times(bundle.ethPriceUSD)

  // reset aggregates with new amounts
  pool.liquidity = pool.liquidity.plus(tier.liquidity)
  pool.amount0 = pool.amount0.plus(tier.amount0)
  pool.amount1 = pool.amount1.plus(tier.amount1)
  pool.totalValueLockedETH = pool.totalValueLockedETH.plus(tier.totalValueLockedETH)
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)
  hub.totalValueLockedETH = hub.totalValueLockedETH.plus(pool.totalValueLockedETH)
  hub.totalValueLockedUSD = hub.totalValueLockedETH.times(bundle.ethPriceUSD)

  updateMuffinDayData(event)
  updatePoolDayData(pool, event)
  updatePoolHourData(pool, event)
  updateTierDayData(tier, event)
  updateTierHourData(tier, event)
  updateTokenDayData(token0, event)
  updateTokenDayData(token1, event)
  updateTokenHourData(token0, event)
  updateTokenHourData(token1, event)

  token0.save()
  token1.save()
  pool.save()
  tier.save()
  hub.save()
}

export function handleMint(event: MintEvent): void {
  let bundle = Bundle.load('1')!
  let hub = Hub.load(HUB_ADDRESS)!
  let pool = Pool.load(event.params.poolId.toHexString())!
  let tier = Tier.load(getTierId(pool.id, event.params.tierId))!

  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)!
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
  let liquidity = decodeLiquidityD8(event.params.liquidityD8)

  let amountUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))

  // reset tvl aggregates until new amounts calculated
  hub.totalValueLockedETH = hub.totalValueLockedETH.minus(pool.totalValueLockedETH)
  pool.totalValueLockedETH = pool.totalValueLockedETH.minus(tier.totalValueLockedETH)
  pool.liquidity = pool.liquidity.minus(tier.liquidity)
  pool.amount0 = pool.amount0.minus(tier.amount0)
  pool.amount1 = pool.amount1.minus(tier.amount1)

  // update globals
  hub.txCount = hub.txCount.plus(ONE_BI)

  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.amountLocked = token0.amountLocked.plus(amount0)
  token0.totalValueLockedUSD = token0.amountLocked.times(token0.derivedETH.times(bundle.ethPriceUSD))

  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.amountLocked = token1.amountLocked.plus(amount1)
  token1.totalValueLockedUSD = token1.amountLocked.times(token1.derivedETH.times(bundle.ethPriceUSD))

  // tier data
  tier.txCount = tier.txCount.plus(ONE_BI)

  // update old ticks' next tick
  // updateTickNextTickAndSave(tier.id, tier.nextTickAbove.toI32(), event.params.tickLower, event.params.tickUpper, event)
  // updateTickNextTickAndSave(tier.id, tier.nextTickBelow.toI32(), event.params.tickLower, event.params.tickUpper, event)

  // Update tier's next tick
  // updateNextTick(tier, event.params.tickLower)
  // updateNextTick(tier, event.params.tickUpper)

  // Pool tiers liquidity tracks the currently active liquidity given pool tiers current tick.
  // We only want to update it on mint if the new position includes the current tick.
  // if (BigInt.fromI32(event.params.tickLower).le(tier.tick) && BigInt.fromI32(event.params.tickUpper).gt(tier.tick)) {
  //   tier.liquidity = tier.liquidity.plus(liquidity)
  // }

  // update from chain data
  let onChainTier = hubContract.getTier(convertPoolIdToBytes(pool.id), tier.tierId)
  tier.liquidity = onChainTier.liquidity
  tier.tick = onChainTier.tick
  tier.nextTickAbove = onChainTier.nextTickAbove
  tier.nextTickBelow = onChainTier.nextTickBelow

  tier.amount0 = tier.amount0.plus(amount0)
  tier.amount1 = tier.amount1.plus(amount1)
  tier.totalValueLockedETH = tier.amount0.times(token0.derivedETH).plus(tier.amount1.times(token1.derivedETH))
  tier.totalValueLockedUSD = tier.totalValueLockedETH.times(bundle.ethPriceUSD)

  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)

  // reset aggregates with new amounts
  pool.liquidity = pool.liquidity.plus(tier.liquidity)
  pool.amount0 = pool.amount0.plus(tier.amount0)
  pool.amount1 = pool.amount1.plus(tier.amount1)
  pool.totalValueLockedETH = pool.totalValueLockedETH.plus(tier.totalValueLockedETH)
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)
  hub.totalValueLockedETH = hub.totalValueLockedETH.plus(pool.totalValueLockedETH)
  hub.totalValueLockedUSD = hub.totalValueLockedETH.times(bundle.ethPriceUSD)

  let transaction = loadTransaction(event)
  let mint = new Mint(transaction.id + '#' + pool.txCount.toString())
  mint.transaction = transaction.id
  mint.timestamp = transaction.timestamp
  mint.pool = pool.id
  mint.tier = tier.id
  mint.token0 = pool.token0
  mint.token1 = pool.token1
  mint.owner = event.params.owner
  mint.positionRefId = event.params.positionRefId
  mint.liquidityD8 = event.params.liquidityD8
  mint.sender = event.params.sender
  mint.senderAccRefId = event.params.senderAccRefId
  mint.origin = event.transaction.from
  mint.amount = liquidity
  mint.amount0 = amount0
  mint.amount1 = amount1
  mint.amountUSD = amountUSD
  mint.tickLower = event.params.tickLower
  mint.tickUpper = event.params.tickUpper
  mint.logIndex = event.logIndex

  // tick entities
  let lowerTickIdx = event.params.tickLower
  let upperTickIdx = event.params.tickUpper

  let lowerTickId = getTickIdWithTierEntityId(tier.id, lowerTickIdx)
  let upperTickId = getTickIdWithTierEntityId(tier.id, upperTickIdx)

  let lowerTick = Tick.load(lowerTickId)
  let upperTick = Tick.load(upperTickId)

  if (lowerTick === null) {
    lowerTick = createTick(lowerTickId, lowerTickIdx, pool.id, event.params.tierId, event)
  }

  if (upperTick === null) {
    upperTick = createTick(upperTickId, upperTickIdx, pool.id, event.params.tierId, event)
  }

  lowerTick.liquidityGross = lowerTick.liquidityGross.plus(liquidity)
  lowerTick.liquidityNet = lowerTick.liquidityNet.plus(liquidity)
  upperTick.liquidityGross = upperTick.liquidityGross.plus(liquidity)
  upperTick.liquidityNet = upperTick.liquidityNet.minus(liquidity)

  // TODO: Update Tick's volume, fees, and liquidity provider count. Computing these on the tick
  // level requires reimplementing some of the swapping code from v3-core.

  updateMuffinDayData(event)
  updatePoolDayData(pool, event)
  updatePoolHourData(pool, event)
  updateTierDayData(tier, event)
  updateTierHourData(tier, event)
  updateTokenDayData(token0, event)
  updateTokenDayData(token1, event)
  updateTokenHourData(token0, event)
  updateTokenHourData(token1, event)

  token0.save()
  token1.save()
  pool.save()
  tier.save()
  hub.save()
  mint.save()

  // Update inner tick vars and save the ticks
  updateTickFeeVarsAndSave(lowerTick, event)
  updateTickFeeVarsAndSave(upperTick, event)

  // Mint event also serve as liquidity increased in a position NFT
  handleIncreaseLiquidity(event)

  // Update internal account balance
  if (amount0.gt(ZERO_BD)) {
    updateAndSaveTokenBalance(token0, event.params.sender, event.params.senderAccRefId)
  }

  if (amount1.gt(ZERO_BD)) {
    updateAndSaveTokenBalance(token1, event.params.sender, event.params.senderAccRefId)
  }
}

export function handleBurn(event: BurnEvent): void {
  let bundle = Bundle.load('1')!
  let pool = Pool.load(event.params.poolId.toHexString())!
  let tier = Tier.load(getTierId(pool.id, event.params.tierId))!
  let hub = Hub.load(HUB_ADDRESS)!

  let token0 = Token.load(pool.token0) as Token
  let token1 = Token.load(pool.token1) as Token
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
  let liquidity = decodeLiquidityD8(event.params.liquidityD8)
  let feeAmount0 = convertTokenToDecimal(event.params.feeAmount0, token0.decimals)
  let feeAmount1 = convertTokenToDecimal(event.params.feeAmount1, token1.decimals)

  let amountUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))

  // reset tvl aggregates until new amounts calculated
  hub.totalValueLockedETH = hub.totalValueLockedETH.minus(pool.totalValueLockedETH)
  pool.totalValueLockedETH = pool.totalValueLockedETH.minus(tier.totalValueLockedETH)
  pool.liquidity = pool.liquidity.minus(tier.liquidity)
  pool.amount0 = pool.amount0.minus(tier.amount0)
  pool.amount1 = pool.amount1.minus(tier.amount1)

  // update globals
  hub.txCount = hub.txCount.plus(ONE_BI)

  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.amountLocked = token0.amountLocked.minus(amount0)
  token0.totalValueLockedUSD = token0.amountLocked.times(token0.derivedETH.times(bundle.ethPriceUSD))

  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.amountLocked = token1.amountLocked.minus(amount1)
  token1.totalValueLockedUSD = token1.amountLocked.times(token1.derivedETH.times(bundle.ethPriceUSD))

  // tier data
  tier.txCount = tier.txCount.plus(ONE_BI)
  // Pool tiers liquidity tracks the currently active liquidity given pool tiers current tick.
  // We only want to update it on burn if the position being burnt includes the current tick.
  // if (BigInt.fromI32(event.params.tickLower).le(tier.tick) && BigInt.fromI32(event.params.tickUpper).gt(tier.tick)) {
  //   tier.liquidity = tier.liquidity.minus(liquidity)
  // }

  // update from chain data
  let onChainTier = hubContract.getTier(convertPoolIdToBytes(pool.id), tier.tierId)
  tier.liquidity = onChainTier.liquidity
  tier.tick = onChainTier.tick
  tier.nextTickAbove = onChainTier.nextTickAbove
  tier.nextTickBelow = onChainTier.nextTickBelow

  // recalculate tier data
  tier.amount0 = tier.amount0.minus(amount0)
  tier.amount1 = tier.amount1.minus(amount1)
  tier.totalValueLockedETH = tier.amount0.times(token0.derivedETH).plus(tier.amount1.times(token1.derivedETH))
  tier.totalValueLockedUSD = tier.totalValueLockedETH.times(bundle.ethPriceUSD)

  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)

  // reset aggregates with new amounts
  pool.liquidity = pool.liquidity.plus(tier.liquidity)
  pool.amount0 = pool.amount0.plus(tier.amount0)
  pool.amount1 = pool.amount1.plus(tier.amount1)
  pool.totalValueLockedETH = pool.totalValueLockedETH.plus(tier.totalValueLockedETH)
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)
  hub.totalValueLockedETH = hub.totalValueLockedETH.plus(pool.totalValueLockedETH)
  hub.totalValueLockedUSD = hub.totalValueLockedETH.times(bundle.ethPriceUSD)

  // burn entity
  let transaction = loadTransaction(event)
  let burn = new Burn(transaction.id + '#' + pool.txCount.toString())
  burn.transaction = transaction.id
  burn.timestamp = transaction.timestamp
  burn.pool = pool.id
  burn.tier = tier.id
  burn.token0 = pool.token0
  burn.token1 = pool.token1
  burn.owner = event.params.owner
  burn.ownerAccRefId = event.params.ownerAccRefId
  burn.positionRefId = event.params.positionRefId
  burn.origin = event.transaction.from
  burn.amount = liquidity
  burn.liquidityD8 = event.params.liquidityD8
  burn.feeAmount0 = feeAmount0
  burn.feeAmount1 = feeAmount1
  burn.amount0 = amount0
  burn.amount1 = amount1
  burn.amountUSD = amountUSD
  burn.tickLower = event.params.tickLower
  burn.tickUpper = event.params.tickUpper
  burn.logIndex = event.logIndex

  // tick entities
  let lowerTickId = getTickIdWithTierEntityId(tier.id, event.params.tickLower)
  let upperTickId = getTickIdWithTierEntityId(tier.id, event.params.tickUpper)
  let lowerTick = Tick.load(lowerTickId)!
  let upperTick = Tick.load(upperTickId)!
  lowerTick.liquidityGross = lowerTick.liquidityGross.minus(liquidity)
  lowerTick.liquidityNet = lowerTick.liquidityNet.minus(liquidity)
  upperTick.liquidityGross = upperTick.liquidityGross.minus(liquidity)
  upperTick.liquidityNet = upperTick.liquidityNet.plus(liquidity)

  // let needUnsetLowerTick = lowerTick.liquidityGross.equals(ZERO_BI)
  // let needUnsetUpperTick = upperTick.liquidityGross.equals(ZERO_BI)

  // // Update tier next tick
  // if (needUnsetLowerTick) {
  //   tier.nextTickBelow = lowerTick.nextTickIdxBelow

  //   let nextTickAboveIdx =
  //     lowerTick.nextTickIdxAbove === upperTick.tickIdx && needUnsetUpperTick
  //       ? upperTick.nextTickIdxAbove
  //       : lowerTick.nextTickIdxAbove

  //   let nextTickAbove = Tick.load(getTickIdWithTierEntityId(tier.id, nextTickAboveIdx))!
  //   nextTickAbove.nextTickIdxBelow = lowerTick.nextTickIdxBelow
  //   nextTickAbove.save()

  //   let nextTickBelow = Tick.load(getTickIdWithTierEntityId(tier.id, lowerTick.nextTickIdxBelow))!
  //   nextTickBelow.nextTickIdxAbove = nextTickAboveIdx
  //   nextTickBelow.save()
  // }

  // if (needUnsetUpperTick) {
  //   tier.nextTickAbove = upperTick.nextTickIdxAbove

  //   // skip when lower tick is empty and is chained by upper tick,
  //   // since the update is done in above code
  //   if (upperTick.nextTickIdxBelow !== lowerTick.tickIdx || !needUnsetLowerTick) {
  //     let nextTickAbove = Tick.load(getTickIdWithTierEntityId(tier.id, upperTick.nextTickIdxAbove))!
  //     nextTickAbove.nextTickIdxBelow = upperTick.nextTickIdxBelow
  //     nextTickAbove.save()

  //     let nextTickBelow = Tick.load(getTickIdWithTierEntityId(tier.id, upperTick.nextTickIdxBelow))!
  //     nextTickBelow.nextTickIdxAbove = upperTick.nextTickIdxAbove
  //     nextTickBelow.save()
  //   }
  // }

  updateMuffinDayData(event)
  updatePoolDayData(pool, event)
  updatePoolHourData(pool, event)
  updateTierDayData(tier, event)
  updateTierHourData(tier, event)
  updateTokenDayData(token0, event)
  updateTokenDayData(token1, event)
  updateTokenHourData(token0, event)
  updateTokenHourData(token1, event)
  updateTickFeeVarsAndSave(lowerTick, event)
  updateTickFeeVarsAndSave(upperTick, event)

  token0.save()
  token1.save()
  pool.save()
  tier.save()
  hub.save()
  burn.save()

  // Burn event also serve as liquidity decreased/fee collected in a position NFT
  handleDecreaseLiquidity(event)

  // Update internal account balance
  if (amount0.gt(ZERO_BD) || feeAmount0.gt(ZERO_BD)) {
    updateAndSaveTokenBalance(token0, event.params.owner, event.params.ownerAccRefId)
  }

  if (amount1.gt(ZERO_BD) || feeAmount1.gt(ZERO_BD)) {
    updateAndSaveTokenBalance(token1, event.params.owner, event.params.ownerAccRefId)
  }
}

export function handleSwap(event: SwapEvent): void {
  let bundle = Bundle.load('1')!
  let hub = Hub.load(HUB_ADDRESS)!
  let pool = Pool.load(event.params.poolId.toHexString())!

  let token0 = Token.load(pool.token0) as Token
  let token1 = Token.load(pool.token1) as Token

  // amounts - 0/1 are token deltas: can be positive or negative
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // need absolute amounts for volume
  let amount0Abs = amount0
  if (amount0.lt(ZERO_BD)) {
    amount0Abs = amount0.times(BigDecimal.fromString('-1'))
  }
  let amount1Abs = amount1
  if (amount1.lt(ZERO_BD)) {
    amount1Abs = amount1.times(BigDecimal.fromString('-1'))
  }

  let amount0ETH = amount0Abs.times(token0.derivedETH)
  let amount1ETH = amount1Abs.times(token1.derivedETH)
  let amount0USD = amount0ETH.times(bundle.ethPriceUSD)
  let amount1USD = amount1ETH.times(bundle.ethPriceUSD)

  // get amount that should be tracked only - div 2 because cant count both input and output as volume
  let amountTotalUSDTracked = getTrackedAmountUSD(amount0Abs, token0, amount1Abs, token1).div(
    BigDecimal.fromString('2')
  )
  let amountTotalETHTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD)
  let amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(BigDecimal.fromString('2'))

  let feesETH = ZERO_BD
  let feesUSD = ZERO_BD
  let liquidity = ZERO_BI
  let tiers: Tier[] = []
  let oldTicks: i32[] = []
  let oldNextTickAboves: i32[] = []
  let oldNextTickBelows: i32[] = []
  let tierFeesUSDs: BigDecimal[] = []

  let amount0Distribution = event.params.amountInDistribution
  let amount1Distribution = event.params.amountOutDistribution
  if (amount0.lt(ZERO_BD) || amount1.gt(ZERO_BD)) {
    amount0Distribution = event.params.amountOutDistribution
    amount1Distribution = event.params.amountInDistribution
  }

  // Loop each tier
  for (let i = 0; i < event.params.tierData.length; i++) {
    let amountInPercent = extractAmountDistributionAtIndex(event.params.amountInDistribution, i)
    let amount0Percent = extractAmountDistributionAtIndex(amount0Distribution, i)
    let amount1Percent = extractAmountDistributionAtIndex(amount1Distribution, i)

    let tier = Tier.load(getTierId(pool.id, i))!
    oldTicks.push(tier.tick)
    oldNextTickAboves.push(tier.nextTickAbove)
    oldNextTickBelows.push(tier.nextTickBelow)

    if (event.params.tierData[i].isZero()) {
      tierFeesUSDs.push(BigDecimal.zero())
    } else {
      let tierData = decodeTierData(event.params.tierData[i])
      let tierLiquidity = tierData[0]
      let tierSqrtPrice = tierData[1]

      // imprecise estimation of fees value in eth or usd
      let tierFeesETH = amountTotalETHTracked
        .times(amountInPercent)
        .times(BigInt.fromI32(tier.feeTier).toBigDecimal())
        .div(BigDecimal.fromString('100000'))
      let tierFeesUSD = amountTotalUSDTracked
        .times(amountInPercent)
        .times(BigInt.fromI32(tier.feeTier).toBigDecimal())
        .div(BigDecimal.fromString('100000'))

      // tier volume
      tier.volumeToken0 = tier.volumeToken0.plus(amount0Abs.times(amount0Percent))
      tier.volumeToken1 = tier.volumeToken1.plus(amount1Abs.times(amount1Percent))
      tier.volumeUSD = tier.volumeUSD.plus(amountTotalUSDTracked.times(amountInPercent)) // imprecisely estimate with amountInPercent
      tier.untrackedVolumeUSD = tier.untrackedVolumeUSD.plus(amountTotalUSDUntracked.times(amountInPercent)) // imprecisely estimate with amountInPercent
      tier.feesUSD = tier.feesUSD.plus(tierFeesUSD)
      tier.txCount = tier.txCount.plus(ONE_BI)

      // Update the pool tier with the new active liquidity, price.
      tier.liquidity = tierLiquidity
      tier.sqrtPrice = tierSqrtPrice
      tier.amount0 = tier.amount0.plus(amount0.times(amount0Percent))
      tier.amount1 = tier.amount1.plus(amount1.times(amount1Percent))

      // updated pool tier ratess
      let prices = sqrtPriceX72ToTokenPrices(tierSqrtPrice, token0, token1)
      tier.token0Price = prices[0]
      tier.token1Price = prices[1]
      feesETH = feesETH.plus(tierFeesETH)
      feesUSD = feesUSD.plus(tierFeesUSD)
      tierFeesUSDs.push(tierFeesUSD)
    }

    liquidity = liquidity.plus(tier.liquidity)
    tiers.push(tier)
  }

  // global updates
  hub.txCount = hub.txCount.plus(ONE_BI)
  hub.totalVolumeETH = hub.totalVolumeETH.plus(amountTotalETHTracked)
  hub.totalVolumeUSD = hub.totalVolumeUSD.plus(amountTotalUSDTracked)
  hub.untrackedVolumeUSD = hub.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  hub.totalFeesETH = hub.totalFeesETH.plus(feesETH)
  hub.totalFeesUSD = hub.totalFeesUSD.plus(feesUSD)

  // update token0 data
  token0.volume = token0.volume.plus(amount0Abs)
  token0.amountLocked = token0.amountLocked.plus(amount0)
  token0.volumeUSD = token0.volumeUSD.plus(amountTotalUSDTracked)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  token0.feesUSD = token0.feesUSD.plus(feesUSD)
  token0.txCount = token0.txCount.plus(ONE_BI)

  // update token1 data
  token1.volume = token1.volume.plus(amount1Abs)
  token1.amountLocked = token1.amountLocked.plus(amount1)
  token1.volumeUSD = token1.volumeUSD.plus(amountTotalUSDTracked)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  token1.feesUSD = token1.feesUSD.plus(feesUSD)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // reset aggregate tvl before individual pool tvl updates
  hub.totalValueLockedETH = hub.totalValueLockedETH.minus(pool.totalValueLockedETH)

  // pool volume
  pool.volumeToken0 = pool.volumeToken0.plus(amount0Abs)
  pool.volumeToken1 = pool.volumeToken1.plus(amount1Abs)
  pool.volumeUSD = pool.volumeUSD.plus(amountTotalUSDTracked)
  pool.untrackedVolumeUSD = pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  pool.feesUSD = pool.feesUSD.plus(feesUSD)
  pool.txCount = pool.txCount.plus(ONE_BI)

  // Update the pool with the new active liquidity, price, and tick.
  pool.liquidity = liquidity
  pool.amount0 = pool.amount0.plus(amount0)
  pool.amount1 = pool.amount1.plus(amount1)

  // updated pool and tier
  pool.save()
  tiers.forEach(function (tier) {
    tier.save()
  })

  // update USD pricing
  bundle.ethPriceUSD = getEthPriceInUSD()
  bundle.save()
  token0.derivedETH = findEthPerToken(token0)
  token1.derivedETH = findEthPerToken(token1)

  /**
   * Things affected by new USD rates
   */
  for (let i = 0; i < tiers.length; i++) {
    let tier = tiers[i]

    // update pool tier tick and fee growth
    let onChainTier = hubContract.getTier(convertPoolIdToBytes(pool.id), tier.tierId)
    tier.liquidity = onChainTier.liquidity
    tier.tick = onChainTier.tick
    tier.nextTickAbove = onChainTier.nextTickAbove
    tier.nextTickBelow = onChainTier.nextTickBelow
    tier.feeGrowthGlobal0X64 = onChainTier.feeGrowthGlobal0
    tier.feeGrowthGlobal1X64 = onChainTier.feeGrowthGlobal1

    tier.totalValueLockedETH = tier.amount0.times(token0.derivedETH).plus(tier.amount1.times(token1.derivedETH))
    tier.totalValueLockedUSD = tier.totalValueLockedETH.times(bundle.ethPriceUSD)
  }

  pool.totalValueLockedETH = pool.amount0.times(token0.derivedETH).plus(pool.amount1.times(token1.derivedETH))
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)

  hub.totalValueLockedETH = hub.totalValueLockedETH.plus(pool.totalValueLockedETH)
  hub.totalValueLockedUSD = hub.totalValueLockedETH.times(bundle.ethPriceUSD)

  token0.totalValueLockedUSD = token0.amountLocked.times(token0.derivedETH).times(bundle.ethPriceUSD)
  token1.totalValueLockedUSD = token1.amountLocked.times(token1.derivedETH).times(bundle.ethPriceUSD)

  // create Swap event
  let transaction = loadTransaction(event)
  let swap = new Swap(transaction.id + '#' + pool.txCount.toString())
  swap.transaction = transaction.id
  swap.timestamp = transaction.timestamp
  swap.pool = pool.id
  swap.token0 = pool.token0
  swap.token1 = pool.token1
  swap.sender = event.params.sender
  swap.origin = event.transaction.from
  swap.sender = event.params.sender
  swap.senderAccRefId = event.params.senderAccRefId
  swap.recipient = event.params.recipient
  swap.recipientAccRefId = event.params.recipientAccRefId
  swap.amount0 = amount0
  swap.amount1 = amount1
  swap.amountUSD = amountTotalUSDTracked
  swap.logIndex = event.logIndex

  let swapTierDatas: SwapTierData[] = []
  for (let i = 0; i < event.params.tierData.length; i++) {
    if (event.params.tierData[i].isZero()) {
      continue
    }

    let swapTierData = new SwapTierData(swap.id + '#' + i.toString())
    let tier = tiers[i]

    let amountInPercent = extractAmountDistributionAtIndex(event.params.amountInDistribution, i)
    let amountOutPercent = extractAmountDistributionAtIndex(event.params.amountOutDistribution, i)
    let amount0Percent = extractAmountDistributionAtIndex(amount0Distribution, i)
    let amount1Percent = extractAmountDistributionAtIndex(amount1Distribution, i)

    swapTierData.transaction = transaction.id
    swapTierData.timestamp = transaction.timestamp
    swapTierData.pool = pool.id
    swapTierData.tier = tier.id
    swapTierData.swap = swap.id
    swapTierData.tick = tier.tick
    swapTierData.token0 = pool.token0
    swapTierData.token1 = pool.token1
    swapTierData.sender = event.params.sender
    swapTierData.origin = event.transaction.from
    swapTierData.senderAccRefId = event.params.senderAccRefId
    swapTierData.recipient = event.params.recipient
    swapTierData.recipientAccRefId = event.params.recipientAccRefId
    swapTierData.amountInPercent = amountInPercent
    swapTierData.amountOutPercent = amountOutPercent
    swapTierData.amount0 = amount0.times(amount0Percent)
    swapTierData.amount1 = amount1.times(amount1Percent)
    swapTierData.amountUSD = amountTotalUSDTracked.times(amountInPercent) // NOTE: imprecisely estimate with amountInPercent
    swapTierData.sqrtPriceX72 = tier.sqrtPrice
    swapTierData.logIndex = event.logIndex

    swapTierDatas.push(swapTierData)

    let tierDayData = updateTierDayData(tier, event)
    let tierHourData = updateTierHourData(tier, event)
    let tierAmount0Abs = amount0Abs.times(amount0Percent)
    let tierAmount1Abs = amount1Abs.times(amount1Percent)

    tierDayData.volumeUSD = tierDayData.volumeUSD.plus(swapTierData.amountUSD)
    tierDayData.volumeToken0 = tierDayData.volumeToken0.plus(tierAmount0Abs)
    tierDayData.volumeToken1 = tierDayData.volumeToken1.plus(tierAmount1Abs)
    tierDayData.feesUSD = tierDayData.feesUSD.plus(tierFeesUSDs[i])

    tierHourData.volumeUSD = tierHourData.volumeUSD.plus(swapTierData.amountUSD)
    tierHourData.volumeToken0 = tierHourData.volumeToken0.plus(tierAmount0Abs)
    tierHourData.volumeToken1 = tierHourData.volumeToken1.plus(tierAmount1Abs)
    tierHourData.feesUSD = tierHourData.feesUSD.plus(tierFeesUSDs[i])

    tierDayData.save()
    tierHourData.save()
  }

  // interval data
  let uniswapDayData = updateMuffinDayData(event)
  let poolDayData = updatePoolDayData(pool, event)
  let poolHourData = updatePoolHourData(pool, event)
  let token0DayData = updateTokenDayData(token0, event)
  let token1DayData = updateTokenDayData(token1, event)
  let token0HourData = updateTokenHourData(token0, event)
  let token1HourData = updateTokenHourData(token1, event)

  // update volume metrics
  uniswapDayData.volumeETH = uniswapDayData.volumeETH.plus(amountTotalETHTracked)
  uniswapDayData.volumeUSD = uniswapDayData.volumeUSD.plus(amountTotalUSDTracked)
  uniswapDayData.feesUSD = uniswapDayData.feesUSD.plus(feesUSD)

  poolDayData.volumeUSD = poolDayData.volumeUSD.plus(amountTotalUSDTracked)
  poolDayData.volumeToken0 = poolDayData.volumeToken0.plus(amount0Abs)
  poolDayData.volumeToken1 = poolDayData.volumeToken1.plus(amount1Abs)
  poolDayData.feesUSD = poolDayData.feesUSD.plus(feesUSD)

  poolHourData.volumeUSD = poolHourData.volumeUSD.plus(amountTotalUSDTracked)
  poolHourData.volumeToken0 = poolHourData.volumeToken0.plus(amount0Abs)
  poolHourData.volumeToken1 = poolHourData.volumeToken1.plus(amount1Abs)
  poolHourData.feesUSD = poolHourData.feesUSD.plus(feesUSD)

  token0DayData.volume = token0DayData.volume.plus(amount0Abs)
  token0DayData.volumeUSD = token0DayData.volumeUSD.plus(amountTotalUSDTracked)
  token0DayData.untrackedVolumeUSD = token0DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token0DayData.feesUSD = token0DayData.feesUSD.plus(feesUSD)

  token0HourData.volume = token0HourData.volume.plus(amount0Abs)
  token0HourData.volumeUSD = token0HourData.volumeUSD.plus(amountTotalUSDTracked)
  token0HourData.untrackedVolumeUSD = token0HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token0HourData.feesUSD = token0HourData.feesUSD.plus(feesUSD)

  token1DayData.volume = token1DayData.volume.plus(amount1Abs)
  token1DayData.volumeUSD = token1DayData.volumeUSD.plus(amountTotalUSDTracked)
  token1DayData.untrackedVolumeUSD = token1DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token1DayData.feesUSD = token1DayData.feesUSD.plus(feesUSD)

  token1HourData.volume = token1HourData.volume.plus(amount1Abs)
  token1HourData.volumeUSD = token1HourData.volumeUSD.plus(amountTotalUSDTracked)
  token1HourData.untrackedVolumeUSD = token1HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token1HourData.feesUSD = token1HourData.feesUSD.plus(feesUSD)

  swap.save()
  swapTierDatas.forEach(function (swapTierData) {
    swapTierData.save()
  })
  token0DayData.save()
  token1DayData.save()
  uniswapDayData.save()
  poolDayData.save()
  hub.save()
  pool.save()
  tiers.forEach(function (tier) {
    tier.save()
  })
  token0.save()
  token1.save()

  let tickSpacing = hubContract.getPoolParameters(convertPoolIdToBytes(pool.id)).value0
  // Update inner vars of current or crossed ticks
  for (let i = 0; i < tiers.length; i++) {
    let tier = tiers[i]
    let oldTick = oldTicks[i]
    let newTick = tier.tick
    let modulo = tier.tick % tickSpacing
    if (modulo === 0) {
      // Current tick is initialized and needs to be updated
      loadTickUpdateFeeVarsAndSave(tier, newTick, event)
    }

    let numIters = abs(oldTick - newTick) / tickSpacing

    if (numIters > 100) {
      // In case more than 100 ticks need to be updated ignore the update in
      // order to avoid timeouts. From testing this behavior occurs only upon
      // pool initialization. This should not be a big issue as the ticks get
      // updated later. For early users this error also disappears when calling
      // collect
    } else if (newTick > oldTick) {
      let firstInitialized = oldTick + tickSpacing - modulo
      for (let j = firstInitialized; j <= newTick; j += tickSpacing) {
        loadTickUpdateFeeVarsAndSave(tier, j, event)
      }
    } else if (newTick < oldTick) {
      let firstInitialized = oldTick - modulo
      for (let j = firstInitialized; j >= newTick; j -= tickSpacing) {
        loadTickUpdateFeeVarsAndSave(tier, j, event)
      }
    }

    // if (oldTick < newTick) {
    //   // update tick info when one for zero
    //   let currentTick = oldNextTickAboves[i]
    //   let endTick = tier.nextTickAbove.toI32()
    //   while (currentTick < endTick) {
    //     let onChainTick = fetchChainTick(pool.id, tier.tierId, currentTick)
    //     let tick = Tick.load(getTickIdWithTierEntityId(tier.id, currentTick))!
    //     let nextTickAbove = tick.nextTickIdxAbove
    //     while (nextTickAbove < onChainTick.nextTickIdxAbove) {
    //       nextTickAbove = unsetTickAndGetNextTick(tier.id, nextTickAbove, ONE_FOR_ZERO, event)
    //     }
    //     updateLimitOrderStartTick(tier, tick, ONE_FOR_ZERO, event)
    //     mergeWithOnChainTickAndSave(tick, onChainTick, event)
    //     currentTick = tick.nextTickIdxAbove
    //   }
    // } else if (oldTick > newTick) {
    //   // update tick info when zero for one
    //   let currentTick = oldNextTickBelows[i]
    //   let endTick = tier.nextTickBelow.toI32()
    //   while (currentTick > endTick) {
    //     let onChainTick = fetchChainTick(pool.id, tier.tierId, currentTick)
    //     let tick = Tick.load(getTickIdWithTierEntityId(tier.id, currentTick))!
    //     let nextTickBelow = tick.nextTickIdxBelow
    //     while (nextTickBelow < onChainTick.nextTickIdxBelow) {
    //       nextTickBelow = unsetTickAndGetNextTick(tier.id, nextTickBelow, ZERO_FOR_ONE, event)
    //     }
    //     updateLimitOrderStartTick(tier, tick, ZERO_FOR_ONE, event)
    //     mergeWithOnChainTickAndSave(tick, onChainTick, event)
    //     currentTick = tick.nextTickIdxBelow
    //   }
  }

  // Update internal account balance
  if (amount0.lt(ZERO_BD)) {
    // swapping token1 for token0
    updateAndSaveTokenBalance(token1, event.params.sender, event.params.senderAccRefId)
    updateAndSaveTokenBalance(token0, event.params.recipient, event.params.recipientAccRefId)
  } else {
    // swapping token0 for token1
    updateAndSaveTokenBalance(token0, event.params.sender, event.params.senderAccRefId)
    updateAndSaveTokenBalance(token1, event.params.recipient, event.params.recipientAccRefId)
  }
}

export function handleCollectSettled(event: CollectSettledEvent): void {
  let pool = Pool.load(event.params.poolId.toHexString())!
  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)!
  let tier = Tier.load(getTierId(pool.id, event.params.tierId))!
  let hub = getOrCreateHub()
  let bundle = Bundle.load('1')!

  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // reset tvl aggregates until new amounts calculated
  hub.totalValueLockedETH = hub.totalValueLockedETH.minus(pool.totalValueLockedETH)
  pool.totalValueLockedETH = pool.totalValueLockedETH.minus(tier.totalValueLockedETH)
  pool.amount0 = pool.amount0.minus(tier.amount0)
  pool.amount1 = pool.amount1.minus(tier.amount1)

  // update globals
  hub.txCount = hub.txCount.plus(ONE_BI)

  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.amountLocked = token0.amountLocked.minus(amount0)
  token0.totalValueLockedUSD = token0.amountLocked.times(token0.derivedETH.times(bundle.ethPriceUSD))

  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.amountLocked = token1.amountLocked.minus(amount1)
  token1.totalValueLockedUSD = token1.amountLocked.times(token1.derivedETH.times(bundle.ethPriceUSD))

  // tier data
  tier.txCount = tier.txCount.plus(ONE_BI)
  tier.amount0 = tier.amount0.minus(amount0)
  tier.amount1 = tier.amount1.minus(amount1)
  tier.totalValueLockedETH = tier.amount0.times(token0.derivedETH).plus(tier.amount1.times(token1.derivedETH))
  tier.totalValueLockedUSD = tier.totalValueLockedETH.times(bundle.ethPriceUSD)

  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)

  // reset aggregates with new amounts
  pool.amount0 = pool.amount0.plus(tier.amount0)
  pool.amount1 = pool.amount1.plus(tier.amount1)
  pool.totalValueLockedETH = pool.totalValueLockedETH.plus(tier.totalValueLockedETH)
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)
  hub.totalValueLockedETH = hub.totalValueLockedETH.plus(pool.totalValueLockedETH)
  hub.totalValueLockedUSD = hub.totalValueLockedETH.times(bundle.ethPriceUSD)

  // create transaction
  let transaction = loadTransaction(event)
  let collectSettled = new CollectSettled(transaction.id + '#' + pool.txCount.toString())
  collectSettled.transaction = transaction.id
  collectSettled.timestamp = transaction.timestamp
  collectSettled.pool = pool.id
  collectSettled.tier = tier.id
  collectSettled.token0 = pool.token0
  collectSettled.token1 = pool.token1
  collectSettled.owner = event.params.owner
  collectSettled.ownerAccRefId = event.params.ownerAccRefId
  collectSettled.positionRefId = event.params.positionRefId
  collectSettled.origin = event.transaction.from
  collectSettled.amount = decodeLiquidityD8(event.params.liquidityD8)
  collectSettled.liquidityD8 = event.params.liquidityD8
  collectSettled.feeAmount0 = convertTokenToDecimal(event.params.feeAmount0, token0.decimals)
  collectSettled.feeAmount1 = convertTokenToDecimal(event.params.feeAmount1, token1.decimals)
  collectSettled.amount0 = amount0
  collectSettled.amount1 = amount1
  collectSettled.amountUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))
  collectSettled.tickLower = event.params.tickLower
  collectSettled.tickUpper = event.params.tickUpper
  collectSettled.logIndex = event.logIndex

  // Aggregate date
  updateMuffinDayData(event)
  updatePoolDayData(pool, event)
  updatePoolHourData(pool, event)
  updateTierDayData(tier, event)
  updateTierHourData(tier, event)
  updateTokenDayData(token0, event)
  updateTokenDayData(token1, event)
  updateTokenHourData(token0, event)
  updateTokenHourData(token1, event)

  // Save
  token0.save()
  token1.save()
  tier.save()
  pool.save()
  hub.save()
  collectSettled.save()

  // Position related
  handleDecreaseLiquidity(changetype<BurnEvent>(event))

  if (event.params.amount0.gt(ZERO_BI) || event.params.feeAmount0.gt(ZERO_BI)) {
    updateAndSaveTokenBalance(token0, event.params.owner, event.params.ownerAccRefId)
  }
  if (event.params.amount1.gt(ZERO_BI) || event.params.feeAmount1.gt(ZERO_BI)) {
    updateAndSaveTokenBalance(token1, event.params.owner, event.params.ownerAccRefId)
  }
}

export function handleDeposit(event: Deposit): void {
  let token = getOrCreateToken(event.params.token)
  if (token === null) return
  let record = getAccountTokenBalance(event.params.recipient, event.params.recipientAccRefId, event.params.token)
  if (record === null) return
  let amount = convertTokenToDecimal(event.params.amount, token.decimals)
  record.balance = record.balance.plus(amount)
  token.save()
  record.save()
}

export function handleWithdraw(event: Withdraw): void {
  let token = Token.load(event.params.token.toHexString())!
  let record = getAccountTokenBalance(event.params.sender, event.params.senderAccRefId, event.params.token)
  if (record === null) return
  let amount = convertTokenToDecimal(event.params.amount, token.decimals)
  record.balance = record.balance.minus(amount)
  record.save()
}

export function handleSetLimitOrderType(event: SetLimitOrderType): void {
  // let tierId = getTierId(event.params.poolId.toHexString(), event.params.tierId)
  // let endTick: Tick | null = null
  // if (event.params.limitOrderType === ZERO_FOR_ONE) {
  //   endTick = Tick.load(getTickIdWithTierEntityId(tierId, event.params.tickLower))!
  //   endTick.limitOrderSpacingZeroForOne = event.params.tickUpper - event.params.tickLower
  // } else if (event.params.limitOrderType === ONE_FOR_ZERO) {
  //   endTick = Tick.load(getTickIdWithTierEntityId(tierId, event.params.tickUpper))!
  //   endTick.limitOrderSpacingOneForZero = event.params.tickUpper - event.params.tickLower
  // }
  // if (endTick !== null) {
  //   endTick.save()
  // }
  handleManagerSetLimitOrderType(event)
}
