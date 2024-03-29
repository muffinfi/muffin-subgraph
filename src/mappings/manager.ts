import { Address } from '@graphprotocol/graph-ts'
import { getPosition, savePositionSnapshot, updateFeeVars } from '../entities/position'
import { Burn, Mint, SetLimitOrderType } from '../types/Hub/Hub'
import { Transfer } from '../types/Manager/Manager'
import { Bundle, Token } from '../types/schema'
import { MANAGER_ADDRESS, ZERO_BI } from '../utils/constants'
import { convertTokenToDecimal, decodeLiquidityD8 } from '../utils/misc'

function isFromManager(owner: Address): boolean {
  return owner.equals(Address.fromString(MANAGER_ADDRESS))
}

export function handleIncreaseLiquidity(event: Mint): void {
  // skip if not from muffin owned Manager
  if (!isFromManager(event.params.owner)) {
    return
  }

  const position = getPosition(event, event.params.positionRefId)

  // position was not able to be fetched
  if (position == null) {
    return
  }

  const bundle = Bundle.load('1')!

  const token0 = Token.load(position.token0)!
  const token1 = Token.load(position.token1)!

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  position.liquidity = position.liquidity.plus(decodeLiquidityD8(event.params.liquidityD8))
  position.depositedToken0 = position.depositedToken0.plus(amount0)
  position.depositedToken1 = position.depositedToken1.plus(amount1)

  const newDepositUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))
  position.amountDepositedUSD = position.amountDepositedUSD.plus(newDepositUSD)

  updateFeeVars(position, event, event.params.positionRefId)
  position.save()
  savePositionSnapshot(position, event)
}

export function handleDecreaseLiquidity(event: Burn): void {
  // skip if not from muffin owned Manager
  if (!isFromManager(event.params.owner)) {
    return
  }

  const position = getPosition(event, event.params.positionRefId)

  // position was not able to be fetched
  if (position == null) {
    return
  }

  const bundle = Bundle.load('1')!
  const token0 = Token.load(position.token0)!
  const token1 = Token.load(position.token1)!
  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  position.liquidity = position.liquidity.minus(decodeLiquidityD8(event.params.liquidityD8))
  position.withdrawnToken0 = position.withdrawnToken0.plus(amount0)
  position.withdrawnToken1 = position.withdrawnToken1.plus(amount1)

  const newWithdrawUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))
  position.amountWithdrawnUSD = position.amountWithdrawnUSD.plus(newWithdrawUSD)

  const feeAmount0 = convertTokenToDecimal(event.params.feeAmount0, token0.decimals)
  const feeAmount1 = convertTokenToDecimal(event.params.feeAmount1, token1.decimals)
  position.collectedToken0 = position.collectedToken0.plus(feeAmount0)
  position.collectedToken1 = position.collectedToken1.plus(feeAmount1)

  position.collectedFeesToken0 = position.collectedToken0.minus(position.withdrawnToken0)
  position.collectedFeesToken1 = position.collectedToken1.minus(position.withdrawnToken1)

  const newCollectUSD = feeAmount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(feeAmount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))
  position.amountCollectedUSD = position.amountCollectedUSD.plus(newCollectUSD)

  // position reset to normal type if it's emptied
  if (position.limitOrderType != 0 && position.liquidity.equals(ZERO_BI)) {
    position.limitOrderType = 0
    position.settlementSnapshotId = ZERO_BI
  }

  updateFeeVars(position, event, event.params.positionRefId)
  position.save()
  savePositionSnapshot(position, event)
}

export function handleTransfer(event: Transfer): void {
  const position = getPosition(event, event.params.tokenId)

  // position was not able to be fetched
  if (position == null) {
    return
  }

  position.owner = event.params.to
  position.save()

  savePositionSnapshot(position, event)
}

export function handleSetLimitOrderType(event: SetLimitOrderType): void {
  // skip if not from muffin owned Manager
  if (!isFromManager(event.params.owner)) {
    return
  }

  const position = getPosition(event, event.params.positionRefId)

  // position was not able to be fetched
  if (position == null) {
    return
  }

  position.limitOrderType = event.params.limitOrderType
  position.save()

  savePositionSnapshot(position, event)
}
