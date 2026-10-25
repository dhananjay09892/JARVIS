/**
 * `createSdkMcpServer` and `tool` for the bridge's own MCP servers.
 *
 * The same functions as the Claude Agent SDK's, except that every server
 * remembers its tool definitions (not enumerable, so the SDK never sees
 * them). That is what lets a tool-loop brain, which has no MCP client, be
 * offered the same tools through the policy-gated tool bridge
 * (brains/sdk-tools.mjs; plan 25, task Q54). Every module that builds a
 * server imports from here rather than from the SDK.
 */
import { createSdkMcpServer as sdkCreateServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { recordingServerFactory } from './brains/sdk-tools.mjs'

export const createSdkMcpServer = recordingServerFactory(sdkCreateServer)
export { tool }
