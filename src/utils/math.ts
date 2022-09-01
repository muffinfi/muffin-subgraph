import { BigInt, ByteArray } from '@graphprotocol/graph-ts'
import { ONE_BI, ZERO_BI } from './constants'

const Q56 = ONE_BI.leftShift(56)
const Q128 = ONE_BI.leftShift(128)
const MAX_UINT256 = ONE_BI.leftShift(255).times(BigInt.fromI32(2)).minus(ONE_BI)

export const MIN_TICK_IDX = -776363
export const MAX_TICK_IDX = 776363

export const MIN_SQRT_PRICE = BigInt.fromString('65539')
export const MAX_SQRT_PRICE = BigInt.fromString('340271175397327323250730767849398346765')

let POWERS_OF_2: BigInt[][] = []

export function getPowersOf2(): BigInt[][] {
  if (POWERS_OF_2.length === 0) {
    POWERS_OF_2 = [
      [BigInt.fromI32(128), Q128],
      [BigInt.fromI32(64), ONE_BI.leftShift(64)],
      [BigInt.fromI32(32), ONE_BI.leftShift(32)],
      [BigInt.fromI32(16), ONE_BI.leftShift(16)],
      [BigInt.fromI32(8), ONE_BI.leftShift(8)],
      [BigInt.fromI32(4), ONE_BI.leftShift(4)],
      [BigInt.fromI32(2), ONE_BI.leftShift(2)],
      [BigInt.fromI32(1), ONE_BI.leftShift(1)],
    ]
  }
  return POWERS_OF_2
}

export function mostSignificantBit(x: BigInt): number {
  let msb = 0
  let powersOf2 = getPowersOf2()
  for (let i = 0; i < powersOf2.length; i++) {
    const powers = powersOf2[i]
    const power = powers[0].toI32()
    if (x.ge(powers[1])) {
      x = x.rightShift(power)
      msb += power
    }
  }
  return msb
}

function mulShift(val: BigInt, mulBy: string): BigInt {
  return val.times(BigInt.fromByteArray(ByteArray.fromHexString(mulBy))).rightShift(128)
}

export function tickToSqrtPriceX72(tick: i32): BigInt {
  assert(tick >= MIN_TICK_IDX && tick <= MAX_TICK_IDX, 'Invalid tick: ' + tick.toString())
  const x = abs(tick)

  let ratio = Q128
  if ((x & 0x1) !== 0) ratio = mulShift(ratio, '0xfffcb933bd6fad37aa2d162d1a594001')
  if ((x & 0x2) !== 0) ratio = mulShift(ratio, '0xfff97272373d413259a46990580e213a')
  if ((x & 0x4) !== 0) ratio = mulShift(ratio, '0xfff2e50f5f656932ef12357cf3c7fdcc')
  if ((x & 0x8) !== 0) ratio = mulShift(ratio, '0xffe5caca7e10e4e61c3624eaa0941cd0')
  if ((x & 0x10) !== 0) ratio = mulShift(ratio, '0xffcb9843d60f6159c9db58835c926644')
  if ((x & 0x20) !== 0) ratio = mulShift(ratio, '0xff973b41fa98c081472e6896dfb254c0')
  if ((x & 0x40) !== 0) ratio = mulShift(ratio, '0xff2ea16466c96a3843ec78b326b52861')
  if ((x & 0x80) !== 0) ratio = mulShift(ratio, '0xfe5dee046a99a2a811c461f1969c3053')
  if ((x & 0x100) !== 0) ratio = mulShift(ratio, '0xfcbe86c7900a88aedcffc83b479aa3a4')
  if ((x & 0x200) !== 0) ratio = mulShift(ratio, '0xf987a7253ac413176f2b074cf7815e54')
  if ((x & 0x400) !== 0) ratio = mulShift(ratio, '0xf3392b0822b70005940c7a398e4b70f3')
  if ((x & 0x800) !== 0) ratio = mulShift(ratio, '0xe7159475a2c29b7443b29c7fa6e889d9')
  if ((x & 0x1000) !== 0) ratio = mulShift(ratio, '0xd097f3bdfd2022b8845ad8f792aa5825')
  if ((x & 0x2000) !== 0) ratio = mulShift(ratio, '0xa9f746462d870fdf8a65dc1f90e061e5')
  if ((x & 0x4000) !== 0) ratio = mulShift(ratio, '0x70d869a156d2a1b890bb3df62baf32f7')
  if ((x & 0x8000) !== 0) ratio = mulShift(ratio, '0x31be135f97d08fd981231505542fcfa6')
  if ((x & 0x10000) !== 0) ratio = mulShift(ratio, '0x09aa508b5b7a84e1c677de54f3e99bc9')
  if ((x & 0x20000) !== 0) ratio = mulShift(ratio, '0x5d6af8dedb81196699c329225ee604')
  if ((x & 0x40000) !== 0) ratio = mulShift(ratio, '0x2216e584f5fa1ea926041bedfe98')
  if ((x & 0x80000) !== 0) ratio = mulShift(ratio, '0x048a170391f7dc42444e8fa2')

  if (tick >= 0) ratio = MAX_UINT256.div(ratio)

  return ratio.mod(Q56).gt(ZERO_BI) ? ratio.rightShift(56).plus(ONE_BI) : ratio.rightShift(56)
}

export function sqrtPriceX72ToTick(sqrtPriceX72: BigInt): i32 {
  assert(sqrtPriceX72.ge(MIN_SQRT_PRICE), 'sqrtPriceX72 too low: ' + sqrtPriceX72.toString())
  assert(sqrtPriceX72.le(MAX_SQRT_PRICE), 'sqrtPriceX72 too high: ' + sqrtPriceX72.toString())

  const msb = mostSignificantBit(sqrtPriceX72)
  let log2 = BigInt.fromI32(msb).minus(BigInt.fromI32(72)).leftShift(64)
  let z = sqrtPriceX72.leftShift(127 - msb)

  for (let i = 0; i < 18; i++) {
    z = z.times(z).rightShift(127)
    if (z.ge(Q128)) {
      z = z.rightShift(1)
      log2 = log2.bitOr(ONE_BI.leftShift(63 - i))
    }
  }

  const logBaseSqrt10001 = log2.times(BigInt.fromString('255738958999603826347141'))
  const tickHigh = logBaseSqrt10001
    .plus(BigInt.fromString('17996007701288367970265332090599899137'))
    .rightShift(128)
    .toI32()

  const tickLow = logBaseSqrt10001
    .minus(
      logBaseSqrt10001.lt(BigInt.fromString('-230154402537746701963478439606373042805014528'))
        ? BigInt.fromString('98577143636729737466164032634120830977')
        : logBaseSqrt10001.lt(BigInt.fromString('-162097929153559009270803518120019400513814528'))
        ? BigInt.fromString('527810000259722480933883300202676225')
        : ZERO_BI
    )
    .rightShift(128)
    .toI32()

  return tickLow === tickHigh || sqrtPriceX72.ge(tickToSqrtPriceX72(tickHigh)) ? tickHigh : tickLow
}
