import { Address } from '@graphprotocol/graph-ts'
import { Burn, Mint, SetLimitOrderType } from '../types/Hub/Hub'
import { Transfer } from '../types/Manager/Manager'
import { Bundle, Token } from '../types/schema'
import { convertTokenToDecimal, decodeLiquidityD8 } from '../utils'
import { MANAGER_ADDRESS } from '../utils/constants'
import { getPosition, savePositionSnapshot, updateFeeVars } from '../utils/position'

function isFromManager(owner: Address): boolean {
  return owner.equals(Address.fromString(MANAGER_ADDRESS))
}

export function handleIncreaseLiquidity(event: Mint): void {
  // skip if not from muffin owned Manager
  if (!isFromManager(event.params.owner)) {
    return
  }

  let position = getPosition(event, event.params.positionRefId)

  // position was not able to be fetched
  if (position == null) {
    return
  }

  let bundle = Bundle.load('1')!

  let token0 = Token.load(position.token0)!
  let token1 = Token.load(position.token1)!

  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  position.liquidity = position.liquidity.plus(decodeLiquidityD8(event.params.liquidityD8))
  position.depositedToken0 = position.depositedToken0.plus(amount0)
  position.depositedToken1 = position.depositedToken1.plus(amount1)

  let newDepositUSD = amount0
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

  let position = getPosition(event, event.params.positionRefId)

  // position was not able to be fetched
  if (position == null) {
    return
  }

  let bundle = Bundle.load('1')!
  let token0 = Token.load(position.token0)!
  let token1 = Token.load(position.token1)!
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  position.liquidity = position.liquidity.minus(decodeLiquidityD8(event.params.liquidityD8))
  position.withdrawnToken0 = position.withdrawnToken0.plus(amount0)
  position.withdrawnToken1 = position.withdrawnToken1.plus(amount1)

  let newWithdrawUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))
  position.amountWithdrawnUSD = position.amountWithdrawnUSD.plus(newWithdrawUSD)

  let feeAmount0 = convertTokenToDecimal(event.params.feeAmount0, token0.decimals)
  let feeAmount1 = convertTokenToDecimal(event.params.feeAmount1, token1.decimals)
  position.collectedToken0 = position.collectedToken0.plus(feeAmount0)
  position.collectedToken1 = position.collectedToken1.plus(feeAmount1)

  position.collectedFeesToken0 = position.collectedToken0.minus(position.withdrawnToken0)
  position.collectedFeesToken1 = position.collectedToken1.minus(position.withdrawnToken1)

  let newCollectUSD = feeAmount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(feeAmount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))
  position.amountCollectedUSD = position.amountCollectedUSD.plus(newCollectUSD)

  updateFeeVars(position, event, event.params.positionRefId)
  position.save()
  savePositionSnapshot(position, event)
}

export function handleTransfer(event: Transfer): void {
  let position = getPosition(event, event.params.tokenId)

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

  let position = getPosition(event, event.params.positionRefId)

  // position was not able to be fetched
  if (position == null) {
    return
  }

  position.limitOrderType = event.params.limitOrderType
  position.save()

  savePositionSnapshot(position, event)
}
