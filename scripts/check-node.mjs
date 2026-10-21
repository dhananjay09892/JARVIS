// Run before the bridge: `node scripts/check-node.mjs && node bridge/server.mjs`.
import { assertNode } from './node-version.mjs'

assertNode()
