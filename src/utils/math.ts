import { BigInt } from '@graphprotocol/graph-ts'
import { ONE_BI, ZERO_BI } from './constants'

const Q56 = ONE_BI.leftShift(56)
const Q128 = ONE_BI.leftShift(128)
export const MAX_UINT256 = BigInt.fromString(
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'
)

export const MIN_TICK_IDX = -776363
export const MAX_TICK_IDX = 776363

export const MIN_SQRT_PRICE = BigInt.fromString('65539')
export const MAX_SQRT_PRICE = BigInt.fromString('340271175397327323250730767849398346765')

export function ceilDiv(x: BigInt, y: BigInt): BigInt {
  return x.div(y).plus(x.mod(y).isZero() ? ONE_BI : ZERO_BI)
}

export function mostSignificantBit(x: BigInt): i32 {
  let msb: i32 = 0
  for (let n: u8 = 128; n >= 1; n >>= 1) {
    if (x.ge(ONE_BI.leftShift(n))) {
      x = x.rightShift(n)
      msb += n
    }
  }
  return msb
}

function mulShift(val: BigInt, mulBy: string, shiftBy: u8): BigInt {
  return val.times(BigInt.fromString(mulBy)).rightShift(shiftBy)
}

export function tickToSqrtPriceX72(tick: i32): BigInt {
  const x = abs(tick)

  let ratio = BigInt.fromString('340282366920938463463374607431768211456')
  if ((x & 0x1) != 0) ratio = mulShift(ratio, '340265354078544963557816517032075149313', 128)
  if ((x & 0x2) != 0) ratio = mulShift(ratio, '340248342086729790484326174814286782778', 128)
  if ((x & 0x4) != 0) ratio = mulShift(ratio, '340214320654664324051920982716015181260', 128)
  if ((x & 0x8) != 0) ratio = mulShift(ratio, '340146287995602323631171512101879684304', 128)
  if ((x & 0x10) != 0) ratio = mulShift(ratio, '340010263488231146823593991679159461444', 128)
  if ((x & 0x20) != 0) ratio = mulShift(ratio, '339738377640345403697157401104375502016', 128)
  if ((x & 0x40) != 0) ratio = mulShift(ratio, '339195258003219555707034227454543997025', 128)
  if ((x & 0x80) != 0) ratio = mulShift(ratio, '338111622100601834656805679988414885971', 128)
  if ((x & 0x100) != 0) ratio = mulShift(ratio, '335954724994790223023589805789778977700', 128)
  if ((x & 0x200) != 0) ratio = mulShift(ratio, '331682121138379247127172139078559817300', 128)
  if ((x & 0x400) != 0) ratio = mulShift(ratio, '323299236684853023288211250268160618739', 128)
  if ((x & 0x800) != 0) ratio = mulShift(ratio, '307163716377032989948697243942600083929', 128)
  if ((x & 0x1000) != 0) ratio = mulShift(ratio, '277268403626896220162999269216087595045', 128)
  if ((x & 0x2000) != 0) ratio = mulShift(ratio, '225923453940442621947126027127485391333', 128)
  if ((x & 0x4000) != 0) ratio = mulShift(ratio, '149997214084966997727330242082538205943', 128)
  if ((x & 0x8000) != 0) ratio = mulShift(ratio, '66119101136024775622716233608466517926', 128)
  if ((x & 0x10000) != 0) ratio = mulShift(ratio, '12847376061809297530290974190478138313', 128)
  if ((x & 0x20000) != 0) ratio = mulShift(ratio, '485053260817066172746253684029974020', 128)
  if ((x & 0x40000) != 0) ratio = mulShift(ratio, '691415978906521570653435304214168', 128)
  if ((x & 0x80000) != 0) ratio = mulShift(ratio, '1404880482679654955896180642', 128)

  if (tick >= 0) ratio = MAX_UINT256.div(ratio)
  return ratio.rightShift(56).plus(ratio.mod(Q56).gt(ZERO_BI) ? ONE_BI : ZERO_BI)
}

export function sqrtPriceX72ToTick(sqrtPriceX72: BigInt): i32 {
  const msb = mostSignificantBit(sqrtPriceX72)

  let log2 = BigInt.fromI32(msb - 72).leftShift(64)
  let z = sqrtPriceX72.leftShift((127 - msb) as u8)

  for (let i: u8 = 0; i < 18; i++) {
    z = z.times(z).rightShift(127)
    if (z.ge(Q128)) {
      z = z.rightShift(1)
      log2 = log2.bitOr(ONE_BI.leftShift(63 - i))
    }
  }

  const logBaseSqrt10001 = log2.times(BigInt.fromString('255738958999603826347141'))
  const _tickUpper = logBaseSqrt10001.plus(BigInt.fromString('17996007701288367970265332090599899137')).rightShift(128)
  const _tickLower = logBaseSqrt10001
    .minus(
      logBaseSqrt10001.lt(BigInt.fromString('-230154402537746701963478439606373042805014528'))
        ? BigInt.fromString('98577143636729737466164032634120830977')
        : logBaseSqrt10001.lt(BigInt.fromString('-162097929153559009270803518120019400513814528'))
        ? BigInt.fromString('527810000259722480933883300202676225')
        : ZERO_BI
    )
    .rightShift(128)

  const tickUpper = _tickUpper.toI32()
  const tickLower = _tickLower.toI32()
  return tickLower == tickUpper || sqrtPriceX72.ge(tickToSqrtPriceX72(tickUpper)) ? tickUpper : tickLower
}
