import { Address, BigInt } from '@graphprotocol/graph-ts'
import { ERC20 } from '../types/Hub/ERC20'
import { ERC20NameBytes } from '../types/Hub/ERC20NameBytes'
import { ERC20SymbolBytes } from '../types/Hub/ERC20SymbolBytes'
import { Token } from '../types/schema'
import { ZERO_BD, ZERO_BI } from '../utils/constants'
import { isNullEthValue } from '../utils/misc'
import { StaticTokenDefinition } from './staticTokenDefinition'

export function loadOrCreateToken(tokenAddress: Address): Token | null {
  let token = Token.load(tokenAddress.toHexString())
  if (token === null) {
    token = new Token(tokenAddress.toHexString())
    token.symbol = fetchTokenSymbol(tokenAddress)
    token.name = fetchTokenName(tokenAddress)
    token.totalSupply = fetchTokenTotalSupply(tokenAddress)
    const decimals = fetchTokenDecimals(tokenAddress)

    // bail if we couldn't figure out the decimals
    if (decimals === null) {
      return null
    }

    token.decimals = decimals
    token.derivedETH = ZERO_BD
    token.volume = ZERO_BD
    token.volumeUSD = ZERO_BD
    token.feesUSD = ZERO_BD
    token.untrackedVolumeUSD = ZERO_BD
    token.amountLocked = ZERO_BD
    token.totalValueLockedUSD = ZERO_BD
    token.txCount = ZERO_BI
    token.poolCount = ZERO_BI
    token.whitelistPools = []
  }
  return token
}

export function fetchTokenSymbol(tokenAddress: Address): string {
  const contract = ERC20.bind(tokenAddress)

  // try types string and bytes32 for symbol
  const symbolResult = contract.try_symbol()
  if (!symbolResult.reverted) {
    return symbolResult.value
  }

  const contractSymbolBytes = ERC20SymbolBytes.bind(tokenAddress)
  const symbolResultBytes = contractSymbolBytes.try_symbol()
  if (!symbolResultBytes.reverted) {
    // for broken pairs that have no symbol function exposed
    if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
      return symbolResultBytes.value.toString()
    }

    // try with the static definition
    const staticTokenDefinition = StaticTokenDefinition.fromAddress(tokenAddress)
    if (staticTokenDefinition != null) {
      return staticTokenDefinition.symbol
    }
  }

  return 'unknown'
}

export function fetchTokenName(tokenAddress: Address): string {
  const contract = ERC20.bind(tokenAddress)

  // try types string and bytes32 for name
  const nameResult = contract.try_name()
  if (!nameResult.reverted) {
    return nameResult.value
  }

  const contractNameBytes = ERC20NameBytes.bind(tokenAddress)
  const nameResultBytes = contractNameBytes.try_name()
  if (!nameResultBytes.reverted) {
    // for broken exchanges that have no name function exposed
    if (!isNullEthValue(nameResultBytes.value.toHexString())) {
      return nameResultBytes.value.toString()
    }

    // try with the static definition
    const staticTokenDefinition = StaticTokenDefinition.fromAddress(tokenAddress)
    if (staticTokenDefinition != null) {
      return staticTokenDefinition.name
    }
  }

  return 'unknown'
}

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
  const contract = ERC20.bind(tokenAddress)
  const totalSupplyResult = contract.try_totalSupply()
  if (!totalSupplyResult.reverted) {
    return totalSupplyResult.value
  }
  return ZERO_BI
}

export function fetchTokenDecimals(tokenAddress: Address): BigInt {
  const contract = ERC20.bind(tokenAddress)
  // try types uint8 for decimals
  let decimalValue = 0
  const decimalResult = contract.try_decimals()
  if (!decimalResult.reverted) {
    decimalValue = decimalResult.value
  } else {
    // try with the static definition
    let staticTokenDefinition = StaticTokenDefinition.fromAddress(tokenAddress)
    if (staticTokenDefinition != null) {
      return staticTokenDefinition.decimals
    }
  }

  return BigInt.fromI32(decimalValue)
}
