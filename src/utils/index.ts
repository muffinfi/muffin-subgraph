import { BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { Bundle, Hub, Transaction } from '../types/schema'
import { BI_18, HUB_ADDRESS, MAX_TIERS, ONE_BD, ONE_BI, ZERO_BD, ZERO_BI } from './constants'

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString('1')
  for (let i = ZERO_BI; i.lt(decimals); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString('10'))
  }
  return bd
}

// return 0 if denominator is 0 in division
export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.equals(ZERO_BD)) {
    return ZERO_BD
  } else {
    return amount0.div(amount1)
  }
}

export function ceilDiv(x: BigInt, y: BigInt): BigInt {
  return x.div(y).plus(x.mod(y).isZero() ? ONE_BI : ZERO_BI)
}

export function bigDecimalExponated(value: BigDecimal, power: BigInt): BigDecimal {
  if (power.equals(ZERO_BI)) {
    return ONE_BD
  }
  let negativePower = power.lt(ZERO_BI)
  let result = ZERO_BD.plus(value)
  let powerAbs = power.abs()
  for (let i = ONE_BI; i.lt(powerAbs); i = i.plus(ONE_BI)) {
    result = result.times(value)
  }

  if (negativePower) {
    result = safeDiv(ONE_BD, result)
  }

  return result
}

export function tokenAmountToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return tokenAmount.toBigDecimal()
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
}

export function priceToDecimal(amount: BigDecimal, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return amount
  }
  return safeDiv(amount, exponentToBigDecimal(exchangeDecimals))
}

export function equalToZero(value: BigDecimal): boolean {
  const formattedVal = parseFloat(value.toString())
  const zero = parseFloat(ZERO_BD.toString())
  if (zero == formattedVal) {
    return true
  }
  return false
}

export function isNullEthValue(value: string): boolean {
  return value == '0x0000000000000000000000000000000000000000000000000000000000000001'
}

export function bigDecimalExp18(): BigDecimal {
  return BigDecimal.fromString('1000000000000000000')
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return tokenAmount.toBigDecimal()
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
}

export function convertEthToDecimal(eth: BigInt): BigDecimal {
  return eth.toBigDecimal().div(exponentToBigDecimal(BI_18))
}

export function decodeLiquidityD8(liquidityD8: BigInt): BigInt {
  return liquidityD8.leftShift(8)
}

export function sliceBits(bitmap: BigInt, startPos: u8, len: u8): BigInt {
  return bitmap.rightShift(startPos).mod(ONE_BI.leftShift(len))
}

// i32 / i32 will be floored by default
const DISTRIBUTION_BIT_LENGTH = (256 / MAX_TIERS) as u8
export function extractAmountDistributionAtIndex(distribution: BigInt, index: i32): BigDecimal {
  return sliceBits(distribution, (index as u8) * DISTRIBUTION_BIT_LENGTH, DISTRIBUTION_BIT_LENGTH).divDecimal(
    ONE_BI.leftShift(DISTRIBUTION_BIT_LENGTH - 1).toBigDecimal()
  )
}

export function decodeTierData(tierData: BigInt): Array<BigInt> {
  // uint256 tierData = [uint128 liquidity, uint128 (UQ56.72) sqrtPrice]
  return [sliceBits(tierData, 0, 128), sliceBits(tierData, 128, 128)]
}

export function loadTransaction(event: ethereum.Event): Transaction {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString())
  }
  transaction.blockNumber = event.block.number
  transaction.timestamp = event.block.timestamp
  transaction.gasLimit = event.transaction.gasLimit
  transaction.gasPrice = event.transaction.gasPrice
  transaction.save()
  return transaction
}

export function getOrCreateHub(): Hub {
  let hub = Hub.load(HUB_ADDRESS)
  if (hub === null) {
    hub = new Hub(HUB_ADDRESS)
    hub.poolCount = ZERO_BI
    hub.totalVolumeETH = ZERO_BD
    hub.totalVolumeUSD = ZERO_BD
    hub.untrackedVolumeUSD = ZERO_BD
    hub.totalFeesUSD = ZERO_BD
    hub.totalFeesETH = ZERO_BD
    hub.totalValueLockedETH = ZERO_BD
    hub.totalValueLockedUSD = ZERO_BD
    hub.txCount = ZERO_BI
    hub.defaultTickSpacing = 200
    hub.defaultProtocolFee = 0

    // create new bundle for tracking eth price
    let bundle = new Bundle('1')
    bundle.ethPriceUSD = ZERO_BD
    bundle.save()
  }
  return hub
}
