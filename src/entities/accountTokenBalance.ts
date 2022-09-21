import { Address, BigInt, ByteArray, Bytes, crypto, ethereum } from '@graphprotocol/graph-ts'
import { AccountTokenBalance, Token } from '../types/schema'
import { hubContract, ZERO_BD, ZERO_BI } from '../utils/constants'
import { convertTokenToDecimal } from '../utils/misc'

export function getAccountHash(owner: Address, accRefId: BigInt): string | null {
  if (accRefId.equals(ZERO_BI)) {
    return null
  }
  const data = [ethereum.Value.fromAddress(owner), ethereum.Value.fromUnsignedBigInt(accRefId)]
  const tuple = changetype<ethereum.Tuple>(data)
  const bytes = ethereum.encode(ethereum.Value.fromTuple(tuple))!
  return crypto.keccak256(bytes).toHexString()
}

export function getAccountTokenBalance(
  owner: Address,
  accRefId: BigInt,
  tokenAddress: Address
): AccountTokenBalance | null {
  const accountHash = getAccountHash(owner, accRefId)
  if (accountHash === null) {
    return null
  }

  const id = tokenAddress.toHexString() + '#' + accountHash
  let balance = AccountTokenBalance.load(id)
  if (balance === null) {
    balance = new AccountTokenBalance(id)
    balance.owner = owner
    balance.accRefId = accRefId
    balance.accountHash = accountHash
    balance.tokenAddress = tokenAddress.toHexString()
    balance.token = tokenAddress.toHexString()
    balance.balance = ZERO_BD
  }
  return balance
}

export function refreshTokenBalance(tokenBalance: AccountTokenBalance, decimals: BigInt): void {
  const amount = hubContract.accounts(
    Address.fromString(tokenBalance.tokenAddress),
    Bytes.fromByteArray(ByteArray.fromHexString(tokenBalance.accountHash))
  )
  tokenBalance.balance = convertTokenToDecimal(amount, decimals)
}

export function updateAndSaveTokenBalance(token: Token, owner: Address, accRefId: BigInt): void {
  const record = getAccountTokenBalance(owner, accRefId, Address.fromString(token.id))
  if (record === null) return
  refreshTokenBalance(record, token.decimals)
  record.save()
}
