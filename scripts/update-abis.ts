import hubArtifact from '@muffinfi/muffin-contracts/artifacts/contracts/MuffinHub.sol/MuffinHub.json'
import hubPositionsArtifact from '@muffinfi/muffin-contracts/artifacts/contracts/MuffinHubPositions.sol/MuffinHubPositions.json'
import managerArtifact from '@muffinfi/muffin-contracts/artifacts/contracts/periphery/Manager.sol/Manager.json'
import fs from 'fs'
import path from 'path'

fs.writeFileSync(path.join(__dirname, '../abis/Hub.json'), JSON.stringify(hubArtifact.abi, null, 2), 'utf8')

fs.writeFileSync(
  path.join(__dirname, '../abis/HubPositions.json'),
  JSON.stringify(hubPositionsArtifact.abi, null, 2),
  'utf8'
)

fs.writeFileSync(path.join(__dirname, '../abis/Manager.json'), JSON.stringify(managerArtifact.abi, null, 2), 'utf8')
