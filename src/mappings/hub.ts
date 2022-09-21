import { BigDecimal, BigInt, log } from '@graphprotocol/graph-ts'
import { getAccountTokenBalance, updateAndSaveTokenBalance } from '../entities/accountTokenBalance'
import { loadOrCreateHub } from '../entities/hub'
import { loadHubPosition } from '../entities/hubPosition'
import {
  updateMuffinDayData,
  updatePoolDayData,
  updatePoolHourData,
  updateTierDayData,
  updateTierHourData,
  updateTokenDayData,
  updateTokenHourData,
} from '../entities/intervalUpdates'
import { createTick } from '../entities/tick'
import { TickController } from '../entities/tickController'
import { TickMapController } from '../entities/tickMapController'
import { BASE_LIQUIDITY, getTierTickIdx, sqrtGammaToFeeTier } from '../entities/tier'
import { loadOrCreateToken } from '../entities/token'
import { loadTransaction } from '../entities/transaction'
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
import { Bundle, Burn, CollectSettled, Hub, Mint, Pool, Swap, SwapTierData, Tier, Token } from '../types/schema'
import {
  hubContract,
  HUB_ADDRESS,
  ONE_BI,
  ONE_FOR_ZERO,
  WHITELIST_TOKENS,
  ZERO_BD,
  ZERO_BI,
  ZERO_FOR_ONE,
} from '../utils/constants'
import { convertPoolIdToBytes, getTierId } from '../utils/id'
import { ceilDiv, MAX_TICK_IDX, MIN_TICK_IDX, sqrtPriceX72ToTick, tickToSqrtPriceX72 } from '../utils/math'
import {
  convertTokenToDecimal,
  decodeLiquidityD8,
  extractAmountDistributionAtIndex,
  getLiquidityFromTierData,
  getSqrtPriceFromTierData,
  safeDiv,
} from '../utils/misc'
import { findEthPerToken, getEthPriceInUSD, getTrackedAmountUSD, sqrtPriceX72ToTokenPrices } from '../utils/pricing'
import {
  handleDecreaseLiquidity,
  handleIncreaseLiquidity,
  handleSetLimitOrderType as handleManagerSetLimitOrderType,
} from './manager'

export function handleUpdateDefaultParameters(event: UpdateDefaultParameters): void {
  const hub = loadOrCreateHub()
  hub.defaultTickSpacing = event.params.tickSpacing
  hub.defaultProtocolFee = event.params.protocolFee
  hub.save()
}

export function handlePoolCreated(event: PoolCreated): void {
  const hub = loadOrCreateHub()
  hub.poolCount = hub.poolCount.plus(ONE_BI)

  const token0 = loadOrCreateToken(event.params.token0)
  const token1 = loadOrCreateToken(event.params.token1)
  const pool = new Pool(event.params.poolId.toHexString())

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
    const newPools = token1.whitelistPools
    newPools.push(pool.id)
    token1.whitelistPools = newPools
  }
  if (WHITELIST_TOKENS.includes(token1.id)) {
    const newPools = token0.whitelistPools
    newPools.push(pool.id)
    token0.whitelistPools = newPools
  }

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

  const params = hubContract.getPoolParameters(convertPoolIdToBytes(pool.id))
  pool.tickSpacing = params.value0
  pool.protocolFee = params.value1

  token0.save()
  token1.save()
  pool.save()
  hub.save()
}

export function handleUpdatePool(event: UpdatePool): void {
  const pool = Pool.load(event.params.poolId.toHexString())!
  pool.tickSpacing = event.params.tickSpacing
  pool.protocolFee = event.params.protocolFee
  pool.save()
}

export function handleUpdateTier(event: UpdateTier): void {
  const pool = Pool.load(event.params.poolId.toHexString())!
  const tierId = getTierId(pool.id, event.params.tierId)
  let tier = Tier.load(tierId)

  if (tier) {
    tier.sqrtGamma = event.params.sqrtGamma
    tier.sqrtPrice = event.params.sqrtPrice
    tier.feeTier = sqrtGammaToFeeTier(event.params.sqrtGamma)
    tier.limitOrderTickSpacingMultiplier = event.params.limitOrderTickSpacingMultiplier
    tier.save()
    return
  }

  const hub = Hub.load(HUB_ADDRESS)!
  const bundle = Bundle.load('1')!
  const token0 = Token.load(pool.token0)!
  const token1 = Token.load(pool.token1)!

  const sqrtPrice = event.params.sqrtPrice
  const amount0 = convertTokenToDecimal(ceilDiv(BigInt.fromI32(100).leftShift(72 + 8), sqrtPrice), token0.decimals)
  const amount1 = convertTokenToDecimal(ceilDiv(BigInt.fromI32(100).times(sqrtPrice), ONE_BI.leftShift(72 - 8)), token1.decimals) // prettier-ignore

  // reset tvl aggregates until new amounts calculated
  hub.totalValueLockedETH = hub.totalValueLockedETH.minus(pool.totalValueLockedETH)

  // update token0 data
  token0.amountLocked = token0.amountLocked.plus(amount0)
  token0.totalValueLockedUSD = token0.amountLocked.times(token0.derivedETH.times(bundle.ethPriceUSD))

  // update token1 data
  token1.amountLocked = token1.amountLocked.plus(amount1)
  token1.totalValueLockedUSD = token1.amountLocked.times(token1.derivedETH.times(bundle.ethPriceUSD))

  // update pool's tier ids
  const tierIds = pool.tierIds
  tierIds.push(tierId)
  pool.tierIds = tierIds

  // init tier
  tier = new Tier(tierId)
  tier.createdAtTimestamp = event.block.timestamp
  tier.createdAtBlockNumber = event.block.number
  tier.pool = pool.id
  tier.poolId = pool.id
  tier.tierId = event.params.tierId
  tier.token0 = pool.token0
  tier.token1 = pool.token1

  const prices = sqrtPriceX72ToTokenPrices(sqrtPrice, token0, token1)
  tier.token0Price = prices[0] // i.e. token0's price denominated in token1
  tier.token1Price = prices[1] // i.e. token1's price denominated in token0
  tier.liquidityProviderCount = ZERO_BI
  tier.txCount = ZERO_BI
  tier.liquidity = BASE_LIQUIDITY
  tier.feeGrowthGlobal0X64 = ZERO_BI
  tier.feeGrowthGlobal1X64 = ZERO_BI
  tier.amount0 = amount0
  tier.amount1 = amount1
  tier.totalValueLockedETH = tier.amount0.times(token0.derivedETH).plus(tier.amount1.times(token1.derivedETH))
  tier.totalValueLockedUSD = tier.totalValueLockedETH.times(bundle.ethPriceUSD)
  tier.totalValueLockedUSDUntracked = ZERO_BD
  tier.volumeToken0 = ZERO_BD
  tier.volumeToken1 = ZERO_BD
  tier.volumeUSD = ZERO_BD
  tier.feesUSD = ZERO_BD
  tier.untrackedVolumeUSD = ZERO_BD
  tier.nextTickBelow = MIN_TICK_IDX
  tier.nextTickAbove = MAX_TICK_IDX
  tier.collectedFeesToken0 = ZERO_BD
  tier.collectedFeesToken1 = ZERO_BD
  tier.collectedFeesUSD = ZERO_BD

  // set from event params
  tier.sqrtGamma = event.params.sqrtGamma
  tier.sqrtPrice = event.params.sqrtPrice
  tier.tick = getTierTickIdx(event.params.sqrtPrice, MAX_TICK_IDX)
  tier.feeTier = sqrtGammaToFeeTier(event.params.sqrtGamma)
  tier.limitOrderTickSpacingMultiplier = event.params.limitOrderTickSpacingMultiplier

  // reset aggregates with new amounts
  pool.liquidity = pool.liquidity.plus(tier.liquidity)
  pool.amount0 = pool.amount0.plus(tier.amount0)
  pool.amount1 = pool.amount1.plus(tier.amount1)
  pool.totalValueLockedETH = pool.totalValueLockedETH.plus(tier.totalValueLockedETH)
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)
  hub.totalValueLockedETH = hub.totalValueLockedETH.plus(pool.totalValueLockedETH)
  hub.totalValueLockedUSD = hub.totalValueLockedETH.times(bundle.ethPriceUSD)

  // init ticks
  const minTick = createTick(pool.id, tier.tierId, MIN_TICK_IDX, event.block)
  minTick.liquidityNet = BASE_LIQUIDITY
  minTick.liquidityGross = BASE_LIQUIDITY
  minTick.nextBelow = MIN_TICK_IDX
  minTick.nextAbove = MAX_TICK_IDX

  const maxTick = createTick(pool.id, tier.tierId, MAX_TICK_IDX, event.block)
  maxTick.liquidityNet = ZERO_BI.minus(BASE_LIQUIDITY)
  maxTick.liquidityGross = BASE_LIQUIDITY
  maxTick.nextBelow = MIN_TICK_IDX
  maxTick.nextAbove = MAX_TICK_IDX

  const tickMap = new TickMapController(pool.id, tier.tierId)
  tickMap.set(MIN_TICK_IDX)
  tickMap.set(MAX_TICK_IDX)

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
  minTick.save()
  maxTick.save()
  tickMap.save()
}

export function handleMint(event: MintEvent): void {
  const bundle = Bundle.load('1')!
  const hub = Hub.load(HUB_ADDRESS)!
  const pool = Pool.load(event.params.poolId.toHexString())!
  const tier = Tier.load(getTierId(pool.id, event.params.tierId))!

  const token0 = Token.load(pool.token0)!
  const token1 = Token.load(pool.token1)!
  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
  const liquidity = decodeLiquidityD8(event.params.liquidityD8)

  const amountUSD = amount0
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

  // update liquidity for tier and ticks
  const tickController = new TickController(pool.id, tier.tierId, event.block)
  const hubPosition = tickController.handleMintOrBurnAndGetHubPosition(
    tier,
    event.params.tickLower,
    event.params.tickUpper,
    liquidity,
    event.params.owner,
    event.params.positionRefId,
    token0.id,
    token1.id
  )

  // recalculate tier data
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

  const transaction = loadTransaction(event)
  const mint = new Mint(transaction.id + '#' + pool.txCount.toString())
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
  tickController.save()
  hubPosition.save()
  mint.save()

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
  const bundle = Bundle.load('1')!
  const pool = Pool.load(event.params.poolId.toHexString())!
  const tier = Tier.load(getTierId(pool.id, event.params.tierId))!
  const hub = Hub.load(HUB_ADDRESS)!

  const token0 = Token.load(pool.token0) as Token
  const token1 = Token.load(pool.token1) as Token
  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
  const liquidity = decodeLiquidityD8(event.params.liquidityD8)
  const feeAmount0 = convertTokenToDecimal(event.params.feeAmount0, token0.decimals)
  const feeAmount1 = convertTokenToDecimal(event.params.feeAmount1, token1.decimals)

  const amountUSD = amount0
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

  // update liquidity for tier and ticks
  const tickController = new TickController(pool.id, tier.tierId, event.block)
  const hubPosition = tickController.handleMintOrBurnAndGetHubPosition(
    tier,
    event.params.tickLower,
    event.params.tickUpper,
    ZERO_BI.minus(liquidity),
    event.params.owner,
    event.params.positionRefId,
    token0.id,
    token1.id
  )

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
  const transaction = loadTransaction(event)
  const burn = new Burn(transaction.id + '#' + pool.txCount.toString())
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
  tickController.save()
  hubPosition.save()
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
  const bundle = Bundle.load('1')!
  const hub = Hub.load(HUB_ADDRESS)!
  const pool = Pool.load(event.params.poolId.toHexString())!

  const token0 = Token.load(pool.token0) as Token
  const token1 = Token.load(pool.token1) as Token

  // amounts - 0/1 are token deltas: can be positive or negative
  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // need absolute amounts for volume
  const amount0Abs = amount0.lt(ZERO_BD) ? amount0.times(BigDecimal.fromString('-1')) : amount0
  const amount1Abs = amount1.lt(ZERO_BD) ? amount1.times(BigDecimal.fromString('-1')) : amount1
  const amount0ETH = amount0Abs.times(token0.derivedETH)
  const amount1ETH = amount1Abs.times(token1.derivedETH)
  const amount0USD = amount0ETH.times(bundle.ethPriceUSD)
  const amount1USD = amount1ETH.times(bundle.ethPriceUSD)

  // get amount that should be tracked only - div 2 because cant count both input and output as volume
  const amountTotalUSDTracked = getTrackedAmountUSD(amount0Abs, token0, amount1Abs, token1).div(
    BigDecimal.fromString('2')
  )
  const amountTotalETHTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD)
  const amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(BigDecimal.fromString('2'))

  let feesETH = ZERO_BD
  let feesUSD = ZERO_BD
  let liquidity = ZERO_BI
  const tiers: Tier[] = []
  const tickControllers: TickController[] = []
  const tierFeesUSDs: BigDecimal[] = []

  let amount0Distribution = event.params.amountInDistribution
  let amount1Distribution = event.params.amountOutDistribution
  if (amount0.lt(ZERO_BD) || amount1.gt(ZERO_BD)) {
    amount0Distribution = event.params.amountOutDistribution
    amount1Distribution = event.params.amountInDistribution
  }

  // Loop each tier
  for (let i = 0; i < event.params.tierData.length; i++) {
    const amountInPercent = extractAmountDistributionAtIndex(event.params.amountInDistribution, i)
    const amount0Percent = extractAmountDistributionAtIndex(amount0Distribution, i)
    const amount1Percent = extractAmountDistributionAtIndex(amount1Distribution, i)

    const tier = Tier.load(getTierId(pool.id, i))!
    const tickController = new TickController(pool.id, tier.tierId, event.block)
    const tierData = event.params.tierData[i]

    if (tierData.isZero()) {
      tierFeesUSDs.push(BigDecimal.zero())
    } else {
      const newLiquidity = getLiquidityFromTierData(tierData)
      const newSqrtPrice = getSqrtPriceFromTierData(tierData)
      const priceGoesDown = newSqrtPrice.lt(tier.sqrtPrice)

      let newTickIdx = sqrtPriceX72ToTick(newSqrtPrice)

      // if price is going down and tier lands exactly on an initialized tick, it can be deduced that
      // the tier already crossed that tick, so we decrement that computed new tick index.
      if (
        priceGoesDown &&
        tickController.try_getTick(newTickIdx) != null &&
        tickToSqrtPriceX72(newTickIdx).equals(newSqrtPrice) &&
        newTickIdx != MIN_TICK_IDX
      ) {
        newTickIdx -= 1
      }

      // if price is going up and tier lands exactly on the upper max price, we decrement the computed
      // new tick index because tier could never cross the upper max tick.
      if (!priceGoesDown && newTickIdx == MAX_TICK_IDX) newTickIdx -= 1

      // imprecise estimation of fees value in eth or usd
      const tierFeesETH = amountTotalETHTracked
        .times(amountInPercent)
        .times(BigInt.fromI32(tier.feeTier).toBigDecimal())
        .div(BigDecimal.fromString('100000'))
      const tierFeesUSD = amountTotalUSDTracked
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

      // update the tier's ticks
      while (true) {
        const nextTickIdx = priceGoesDown ? tier.nextTickBelow : tier.nextTickAbove
        if (priceGoesDown) {
          if (tier.nextTickBelow <= newTickIdx) break
        } else {
          if (tier.nextTickAbove > newTickIdx) break
        }

        const tickCross = tickController.getTick(nextTickIdx)
        tickController.flagUpdated(tickCross.tickIdx)

        // update tier next tick below and above
        if (priceGoesDown) {
          tier.nextTickBelow = tickCross.nextBelow
          tier.nextTickAbove = tickCross.tickIdx
          if (tickCross.limitOrderTickSpacing1For0 > 0) tickController.settle(tickCross, ONE_FOR_ZERO, tier)
        } else {
          tier.nextTickAbove = tickCross.nextAbove
          tier.nextTickBelow = tickCross.tickIdx
          if (tickCross.limitOrderTickSpacing0For1 > 0) tickController.settle(tickCross, ZERO_FOR_ONE, tier)
        }
      }

      // Update the tier with the new active liquidity, price.
      tier.liquidity = newLiquidity
      tier.sqrtPrice = newSqrtPrice
      tier.tick = newTickIdx
      tier.amount0 = tier.amount0.plus(amount0.times(amount0Percent))
      tier.amount1 = tier.amount1.plus(amount1.times(amount1Percent))

      // updated pool tier ratess
      const prices = sqrtPriceX72ToTokenPrices(newSqrtPrice, token0, token1)
      tier.token0Price = prices[0]
      tier.token1Price = prices[1]
      feesETH = feesETH.plus(tierFeesETH)
      feesUSD = feesUSD.plus(tierFeesUSD)
      tierFeesUSDs.push(tierFeesUSD)
    }

    liquidity = liquidity.plus(tier.liquidity)
    tiers.push(tier)
    tickControllers.push(tickController)
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
  let maxUpdateCount = 50
  for (let i = 0; i < tickControllers.length; i++) {
    // Update inner vars of current or crossed ticks and save
    // If too many ticks, ignore the fee growth updates to avoid timeout. The tick's feeGrowthOutside will
    // be wrong after that but it at worst affects the calculation of the position's unclaimed fee.
    maxUpdateCount -= tickControllers[i].updateTickFeeVarsAndSave(maxUpdateCount)
  }

  // update USD pricing
  bundle.ethPriceUSD = getEthPriceInUSD()
  bundle.save()
  token0.derivedETH = findEthPerToken(token0)
  token1.derivedETH = findEthPerToken(token1)

  /**
   * Things affected by new USD rates
   */
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]

    // update tier fee growth
    const onChainTier = hubContract.getTier(convertPoolIdToBytes(pool.id), tier.tierId)
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
  const transaction = loadTransaction(event)
  const swap = new Swap(transaction.id + '#' + pool.txCount.toString())
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

  const swapTierDatas: SwapTierData[] = []
  for (let i = 0; i < event.params.tierData.length; i++) {
    if (event.params.tierData[i].isZero()) {
      continue
    }

    const swapTierData = new SwapTierData(swap.id + '#' + i.toString())
    const tier = tiers[i]

    const amountInPercent = extractAmountDistributionAtIndex(event.params.amountInDistribution, i)
    const amountOutPercent = extractAmountDistributionAtIndex(event.params.amountOutDistribution, i)
    const amount0Percent = extractAmountDistributionAtIndex(amount0Distribution, i)
    const amount1Percent = extractAmountDistributionAtIndex(amount1Distribution, i)

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

    const tierDayData = updateTierDayData(tier, event)
    const tierHourData = updateTierHourData(tier, event)
    const tierAmount0Abs = amount0Abs.times(amount0Percent)
    const tierAmount1Abs = amount1Abs.times(amount1Percent)

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
  const uniswapDayData = updateMuffinDayData(event)
  const poolDayData = updatePoolDayData(pool, event)
  const poolHourData = updatePoolHourData(pool, event)
  const token0DayData = updateTokenDayData(token0, event)
  const token1DayData = updateTokenDayData(token1, event)
  const token0HourData = updateTokenHourData(token0, event)
  const token1HourData = updateTokenHourData(token1, event)

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
  const pool = Pool.load(event.params.poolId.toHexString())!
  const token0 = Token.load(pool.token0)!
  const token1 = Token.load(pool.token1)!
  const tier = Tier.load(getTierId(pool.id, event.params.tierId))!
  const hub = loadOrCreateHub()
  const bundle = Bundle.load('1')!
  const position = loadHubPosition(
    event.params.poolId.toHexString(),
    event.params.owner,
    event.params.positionRefId,
    event.params.tierId,
    event.params.tickLower,
    event.params.tickUpper
  )!

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

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

  // update hub position
  const liquidity = decodeLiquidityD8(event.params.liquidityD8)
  position.liquidity = position.liquidity.minus(liquidity)
  if (position.liquidity.isZero()) position.limitOrderType = 0

  // create transaction
  const transaction = loadTransaction(event)
  const collectSettled = new CollectSettled(transaction.id + '#' + pool.txCount.toString())
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
  collectSettled.amount = liquidity
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
  position.save()
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

export function handleSetLimitOrderType(event: SetLimitOrderType): void {
  const position = loadHubPosition(
    event.params.poolId.toHexString(),
    event.params.owner,
    event.params.positionRefId,
    event.params.tierId,
    event.params.tickLower,
    event.params.tickUpper
  )!

  const ticks = new TickController(position.poolId, position.tierId, event.block)

  if (position.limitOrderType != 0) {
    ticks.updateLimitOrderData(
      position.tickLower,
      position.tickUpper,
      position.limitOrderType,
      ZERO_BI.minus(position.liquidity)
    )
  }

  if (event.params.limitOrderType != 0) {
    ticks.updateLimitOrderData(position.tickLower, position.tickUpper, event.params.limitOrderType, position.liquidity)
  }

  position.limitOrderType = event.params.limitOrderType
  position.save()
  ticks.save()

  handleManagerSetLimitOrderType(event)
}

export function handleDeposit(event: Deposit): void {
  const token = loadOrCreateToken(event.params.token)
  if (token === null) return
  const record = getAccountTokenBalance(event.params.recipient, event.params.recipientAccRefId, event.params.token)
  if (record === null) return
  const amount = convertTokenToDecimal(event.params.amount, token.decimals)
  record.balance = record.balance.plus(amount)
  token.save()
  record.save()
}

export function handleWithdraw(event: Withdraw): void {
  const token = Token.load(event.params.token.toHexString())!
  const record = getAccountTokenBalance(event.params.sender, event.params.senderAccRefId, event.params.token)
  if (record === null) return
  const amount = convertTokenToDecimal(event.params.amount, token.decimals)
  record.balance = record.balance.minus(amount)
  record.save()
}
