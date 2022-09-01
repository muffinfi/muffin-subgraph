import { ethereum } from '@graphprotocol/graph-ts'
import {
  Bundle,
  Hub,
  MuffinDayData,
  Pool,
  PoolDayData,
  PoolHourData,
  Tick,
  TickDayData,
  Tier,
  TierDayData,
  TierHourData,
  Token,
  TokenDayData,
  TokenHourData,
} from './../types/schema'
import { HUB_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI } from './constants'

/**
 * Tracks global aggregate data over daily windows
 * @param event
 */
export function updateMuffinDayData(event: ethereum.Event): MuffinDayData {
  let muffin = Hub.load(HUB_ADDRESS)!
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400 // rounded
  let dayStartTimestamp = dayID * 86400
  let muffinDayData = MuffinDayData.load(dayID.toString())
  if (muffinDayData === null) {
    muffinDayData = new MuffinDayData(dayID.toString())
    muffinDayData.date = dayStartTimestamp
    muffinDayData.volumeETH = ZERO_BD
    muffinDayData.volumeUSD = ZERO_BD
    muffinDayData.volumeUSDUntracked = ZERO_BD
    muffinDayData.feesUSD = ZERO_BD
  }
  muffinDayData.tvlUSD = muffin.totalValueLockedUSD
  muffinDayData.txCount = muffin.txCount
  muffinDayData.save()
  return muffinDayData
}

export function updatePoolDayData(pool: Pool, event: ethereum.Event): PoolDayData {
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let dayPoolID = pool.id.concat('-').concat(dayID.toString())
  let poolDayData = PoolDayData.load(dayPoolID)
  if (poolDayData === null) {
    poolDayData = new PoolDayData(dayPoolID)
    poolDayData.date = dayStartTimestamp
    poolDayData.pool = pool.id
    // things that dont get initialized always
    poolDayData.volumeToken0 = ZERO_BD
    poolDayData.volumeToken1 = ZERO_BD
    poolDayData.volumeUSD = ZERO_BD
    poolDayData.feesUSD = ZERO_BD
    poolDayData.txCount = ZERO_BI
  }

  poolDayData.liquidity = pool.liquidity
  poolDayData.tvlUSD = pool.totalValueLockedUSD
  poolDayData.txCount = poolDayData.txCount.plus(ONE_BI)
  poolDayData.save()

  return poolDayData
}

export function updatePoolHourData(pool: Pool, event: ethereum.Event): PoolHourData {
  let timestamp = event.block.timestamp.toI32()
  let hourIndex = timestamp / 3600 // get unique hour within unix history
  let hourStartUnix = hourIndex * 3600 // want the rounded effect
  let hourPoolID = pool.id.concat('-').concat(hourIndex.toString())
  let poolHourData = PoolHourData.load(hourPoolID)
  if (poolHourData === null) {
    poolHourData = new PoolHourData(hourPoolID)
    poolHourData.periodStartUnix = hourStartUnix
    poolHourData.pool = pool.id
    // things that dont get initialized always
    poolHourData.volumeToken0 = ZERO_BD
    poolHourData.volumeToken1 = ZERO_BD
    poolHourData.volumeUSD = ZERO_BD
    poolHourData.txCount = ZERO_BI
    poolHourData.feesUSD = ZERO_BD
  }

  poolHourData.liquidity = pool.liquidity
  poolHourData.tvlUSD = pool.totalValueLockedUSD
  poolHourData.txCount = poolHourData.txCount.plus(ONE_BI)
  poolHourData.save()

  return poolHourData
}

export function updateTierDayData(tier: Tier, event: ethereum.Event): TierDayData {
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let dayTierID = tier.id.concat('-').concat(dayID.toString())
  let tierDayData = TierDayData.load(dayTierID)
  if (tierDayData === null) {
    tierDayData = new TierDayData(dayTierID)
    tierDayData.date = dayStartTimestamp
    tierDayData.pool = tier.poolId
    tierDayData.tier = tier.id
    // things that dont get initialized always
    tierDayData.volumeToken0 = ZERO_BD
    tierDayData.volumeToken1 = ZERO_BD
    tierDayData.volumeUSD = ZERO_BD
    tierDayData.feesUSD = ZERO_BD
    tierDayData.txCount = ZERO_BI
    tierDayData.feeGrowthGlobal0X64 = ZERO_BI
    tierDayData.feeGrowthGlobal1X64 = ZERO_BI
    tierDayData.open = tier.token0Price
    tierDayData.high = tier.token0Price
    tierDayData.low = tier.token0Price
    tierDayData.close = tier.token0Price
  }

  if (tier.token0Price.gt(tierDayData.high)) {
    tierDayData.high = tier.token0Price
  }
  if (tier.token0Price.lt(tierDayData.low)) {
    tierDayData.low = tier.token0Price
  }

  tierDayData.liquidity = tier.liquidity
  tierDayData.sqrtPrice = tier.sqrtPrice
  tierDayData.feeGrowthGlobal0X64 = tier.feeGrowthGlobal0X64
  tierDayData.feeGrowthGlobal1X64 = tier.feeGrowthGlobal1X64
  tierDayData.close = tier.token0Price
  tierDayData.token0Price = tier.token0Price
  tierDayData.token1Price = tier.token1Price
  tierDayData.tick = tier.tick
  tierDayData.tvlUSD = tier.totalValueLockedUSD
  tierDayData.txCount = tierDayData.txCount.plus(ONE_BI)
  tierDayData.save()

  return tierDayData
}

export function updateTierHourData(tier: Tier, event: ethereum.Event): TierHourData {
  let timestamp = event.block.timestamp.toI32()
  let hourIndex = timestamp / 3600 // get unique hour within unix history
  let hourStartUnix = hourIndex * 3600 // want the rounded effect
  let hourTierID = tier.id.concat('-').concat(hourIndex.toString())
  let tierHourData = TierHourData.load(hourTierID)
  if (tierHourData === null) {
    tierHourData = new TierHourData(hourTierID)
    tierHourData.periodStartUnix = hourStartUnix
    tierHourData.pool = tier.poolId
    tierHourData.tier = tier.id
    // things that dont get initialized always
    tierHourData.volumeToken0 = ZERO_BD
    tierHourData.volumeToken1 = ZERO_BD
    tierHourData.volumeUSD = ZERO_BD
    tierHourData.txCount = ZERO_BI
    tierHourData.feesUSD = ZERO_BD
    tierHourData.feeGrowthGlobal0X64 = ZERO_BI
    tierHourData.feeGrowthGlobal1X64 = ZERO_BI
    tierHourData.open = tier.token0Price
    tierHourData.high = tier.token0Price
    tierHourData.low = tier.token0Price
    tierHourData.close = tier.token0Price
  }

  if (tier.token0Price.gt(tierHourData.high)) {
    tierHourData.high = tier.token0Price
  }
  if (tier.token0Price.lt(tierHourData.low)) {
    tierHourData.low = tier.token0Price
  }

  tierHourData.liquidity = tier.liquidity
  tierHourData.sqrtPrice = tier.sqrtPrice
  tierHourData.token0Price = tier.token0Price
  tierHourData.token1Price = tier.token1Price
  tierHourData.feeGrowthGlobal0X64 = tier.feeGrowthGlobal0X64
  tierHourData.feeGrowthGlobal1X64 = tier.feeGrowthGlobal1X64
  tierHourData.close = tier.token0Price
  tierHourData.tick = tier.tick
  tierHourData.tvlUSD = tier.totalValueLockedUSD
  tierHourData.txCount = tierHourData.txCount.plus(ONE_BI)
  tierHourData.save()

  return tierHourData
}

export function updateTokenDayData(token: Token, event: ethereum.Event): TokenDayData {
  let bundle = Bundle.load('1')!
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let tokenDayID = token.id.toString().concat('-').concat(dayID.toString())
  let tokenPrice = token.derivedETH.times(bundle.ethPriceUSD)

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    tokenDayData.date = dayStartTimestamp
    tokenDayData.token = token.id
    tokenDayData.volume = ZERO_BD
    tokenDayData.volumeUSD = ZERO_BD
    tokenDayData.feesUSD = ZERO_BD
    tokenDayData.untrackedVolumeUSD = ZERO_BD
    tokenDayData.open = tokenPrice
    tokenDayData.high = tokenPrice
    tokenDayData.low = tokenPrice
    tokenDayData.close = tokenPrice
  }

  if (tokenPrice.gt(tokenDayData.high)) {
    tokenDayData.high = tokenPrice
  }

  if (tokenPrice.lt(tokenDayData.low)) {
    tokenDayData.low = tokenPrice
  }

  tokenDayData.close = tokenPrice
  tokenDayData.priceUSD = token.derivedETH.times(bundle.ethPriceUSD)
  tokenDayData.amountLocked = token.amountLocked
  tokenDayData.totalValueLockedUSD = token.totalValueLockedUSD
  tokenDayData.save()

  return tokenDayData
}

export function updateTokenHourData(token: Token, event: ethereum.Event): TokenHourData {
  let bundle = Bundle.load('1')!
  let timestamp = event.block.timestamp.toI32()
  let hourIndex = timestamp / 3600 // get unique hour within unix history
  let hourStartUnix = hourIndex * 3600 // want the rounded effect
  let tokenHourID = token.id.toString().concat('-').concat(hourIndex.toString())
  let tokenHourData = TokenHourData.load(tokenHourID)
  let tokenPrice = token.derivedETH.times(bundle.ethPriceUSD)

  if (tokenHourData === null) {
    tokenHourData = new TokenHourData(tokenHourID)
    tokenHourData.periodStartUnix = hourStartUnix
    tokenHourData.token = token.id
    tokenHourData.volume = ZERO_BD
    tokenHourData.volumeUSD = ZERO_BD
    tokenHourData.untrackedVolumeUSD = ZERO_BD
    tokenHourData.feesUSD = ZERO_BD
    tokenHourData.open = tokenPrice
    tokenHourData.high = tokenPrice
    tokenHourData.low = tokenPrice
    tokenHourData.close = tokenPrice
  }

  if (tokenPrice.gt(tokenHourData.high)) {
    tokenHourData.high = tokenPrice
  }

  if (tokenPrice.lt(tokenHourData.low)) {
    tokenHourData.low = tokenPrice
  }

  tokenHourData.close = tokenPrice
  tokenHourData.priceUSD = tokenPrice
  tokenHourData.amountLocked = token.amountLocked
  tokenHourData.totalValueLockedUSD = token.totalValueLockedUSD
  tokenHourData.save()

  return tokenHourData
}

export function updateTickDayData(tick: Tick, event: ethereum.Event): TickDayData {
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let tickDayDataID = tick.id.concat('-').concat(dayID.toString())
  let tickDayData = TickDayData.load(tickDayDataID)
  if (tickDayData === null) {
    tickDayData = new TickDayData(tickDayDataID)
    tickDayData.date = dayStartTimestamp
    tickDayData.pool = tick.pool
    tickDayData.tier = tick.tier
    tickDayData.tick = tick.id
  }
  tickDayData.liquidityGross = tick.liquidityGross
  tickDayData.liquidityNet = tick.liquidityNet
  // tickDayData.volumeToken0 = tick.volumeToken0
  // tickDayData.volumeToken1 = tick.volumeToken1
  // tickDayData.volumeUSD = tick.volumeUSD
  // tickDayData.feesUSD = tick.feesUSD
  tickDayData.feeGrowthOutside0X64 = tick.feeGrowthOutside0X64
  tickDayData.feeGrowthOutside1X64 = tick.feeGrowthOutside1X64

  tickDayData.save()

  return tickDayData
}
