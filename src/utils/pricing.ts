import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { exponentToBigDecimal, safeDiv } from '../utils/index'
import { Bundle, Pool, Tier, Token } from './../types/schema'
import {
  ONE_BD,
  ONE_BI,
  STABLE_COINS,
  USDC_ADDRESS,
  WETH_ADDRESS,
  WHITELIST_TOKENS,
  ZERO_BD,
  ZERO_BI,
} from './constants'
import { getPoolId } from './pool'
import { getTierId } from './tier'

let MINIMUM_ETH_LOCKED = BigDecimal.fromString('52')

let PRICE_DENOM = ONE_BI.leftShift(144).toBigDecimal()
export function sqrtPriceX72ToTokenPrices(sqrtPriceX72: BigInt, token0: Token, token1: Token): BigDecimal[] {
  let num = sqrtPriceX72.times(sqrtPriceX72).toBigDecimal()
  let price1 = num
    .div(PRICE_DENOM)
    .times(exponentToBigDecimal(token0.decimals))
    .div(exponentToBigDecimal(token1.decimals))

  let price0 = safeDiv(ONE_BD, price1)
  return [price0, price1]
}

const IS_USDC_TOKEN0_IN_WETH_POOL = USDC_ADDRESS < WETH_ADDRESS

/**
 * NOTE:
 * We arbitrarily pick a tier in eth/usdc pool to be the reference price for bundle. This is currently assumed
 * this tier will have enough liquidity so the price stays relevant. Otherwise, we'll change to use another tier.
 */
const USDC_WETH_POOL_TIER_ID = 0

const USDC_WETH_POOL = IS_USDC_TOKEN0_IN_WETH_POOL
  ? getPoolId(Address.fromString(USDC_ADDRESS), Address.fromString(WETH_ADDRESS))
  : getPoolId(Address.fromString(WETH_ADDRESS), Address.fromString(USDC_ADDRESS))
const USDC_WETH_POOL_TIER = getTierId(USDC_WETH_POOL, USDC_WETH_POOL_TIER_ID)
export function getEthPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  let usdcTier = Tier.load(USDC_WETH_POOL_TIER)
  if (usdcTier !== null) {
    return IS_USDC_TOKEN0_IN_WETH_POOL ? usdcTier.token0Price : usdcTier.token1Price
  } else {
    return ZERO_BD
  }
}

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(token: Token): BigDecimal {
  if (token.id == WETH_ADDRESS) {
    return ONE_BD
  }
  let whiteList = token.whitelistPools
  // for now just take USD from pool with greatest TVL
  // need to update this to actually detect best rate based on liquidity distribution
  let largestEthLocked = ZERO_BD
  let priceSoFar = ZERO_BD
  let bundle = Bundle.load('1')!

  // hardcoded fix for incorrect rates
  // if whitelist includes token - get the safe price
  if (STABLE_COINS.includes(token.id)) {
    priceSoFar = safeDiv(ONE_BD, bundle.ethPriceUSD)
  } else {
    // use the price from the tier with largest tvl denominated in eth
    for (let i = 0; i < whiteList.length; ++i) {
      let poolId = whiteList[i]
      let pool = Pool.load(poolId)!

      for (let j = 0; j < pool.tierIds.length; ++j) {
        let tierId = pool.tierIds[j]
        let tier = Tier.load(tierId)!
        if (!tier.liquidity.gt(ZERO_BI)) continue

        if (tier.token0 == token.id) {
          // whitelist token is token1
          let token1 = Token.load(tier.token1)!
          // get the derived ETH in pool tier
          let ethLocked = tier.amount1.times(token1.derivedETH)

          if (ethLocked.gt(largestEthLocked) && ethLocked.gt(MINIMUM_ETH_LOCKED)) {
            largestEthLocked = ethLocked
            // token1 per our token * Eth per token1
            priceSoFar = tier.token1Price.times(token1.derivedETH)
          }
        }

        if (tier.token1 == token.id) {
          let token0 = Token.load(tier.token0)!
          // get the derived ETH in pool tier
          let ethLocked = tier.amount0.times(token0.derivedETH)

          if (ethLocked.gt(largestEthLocked) && ethLocked.gt(MINIMUM_ETH_LOCKED)) {
            largestEthLocked = ethLocked
            // token0 per our token * ETH per token0
            priceSoFar = tier.token0Price.times(token0.derivedETH)
          }
        }
      }
    }
  }
  return priceSoFar // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedAmountUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let bundle = Bundle.load('1') as Bundle
  let price0USD = token0.derivedETH.times(bundle.ethPriceUSD)
  let price1USD = token1.derivedETH.times(bundle.ethPriceUSD)

  // both are whitelist tokens, return sum of both amounts
  if (WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount0.times(price0USD).plus(tokenAmount1.times(price1USD))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST_TOKENS.includes(token0.id) && !WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount0.times(price0USD).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount1.times(price1USD).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked amount is 0
  return ZERO_BD
}
