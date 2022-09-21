import { Bundle, Hub } from '../types/schema'
import { HUB_ADDRESS, ZERO_BD, ZERO_BI } from '../utils/constants'

export function loadOrCreateHub(): Hub {
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
    hub.defaultTickSpacing = 100
    hub.defaultProtocolFee = 0

    // create new bundle for tracking eth price
    const bundle = new Bundle('1')
    bundle.ethPriceUSD = ZERO_BD
    bundle.save()
  }

  return hub
}
