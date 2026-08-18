/* global process */
/**
 * Moluoxixi Session Start Plugin
 *
 * Injects context when user sends the first message in a session.
 * Uses OpenCode's chat.message hook directly so the context persists in history.
 */

import { MoluoxixiContext, contextCollector, debugLog, isMoluoxixiSubagent } from "../lib/moluoxixi-context.js"
import { insertSyntheticTextPart } from "../lib/context-visibility.js"
import {
  buildSessionContext,
  hasPersistedInjectedContext,
  markContextInjected,
} from "../lib/session-utils.js"

// OpenCode 1.2.x expects plugins to be factory functions (see inject-subagent-context.js comment).
export default async ({ directory, client }) => {
  const ctx = new MoluoxixiContext(directory)
  debugLog("session", "Plugin loaded, directory:", directory)

  return {
    // chat.message - triggered when user sends a message.
    // Insert a complete synthetic part so the context persists without changing the user prompt.
    "chat.message": async (input, output) => {
      try {
        const sessionID = input.sessionID
        const agent = input.agent || "unknown"
        debugLog("session", "chat.message called, sessionID:", sessionID, "agent:", agent)

        // Skip Moluoxixi sub-agent turns — sub-agent context is injected by
        // `inject-subagent-context.js` on the parent's tool.execute.before;
        // re-injecting the main-session SessionStart here would drown that.
        if (isMoluoxixiSubagent(input)) {
          debugLog("session", "Skipping moluoxixi subagent turn:", agent)
          return
        }

        if (process.env.MOLUOXIXI_HOOKS === "0" || process.env.MOLUOXIXI_DISABLE_HOOKS === "1") {
          debugLog("session", "Skipping - MOLUOXIXI_HOOKS disabled")
          return
        }

        if (process.env.OPENCODE_NON_INTERACTIVE === "1") {
          debugLog("session", "Skipping - non-interactive mode")
          return
        }

        if (contextCollector.isProcessed(sessionID)) {
          debugLog("session", "Skipping - session already processed")
          return
        }

        if (await hasPersistedInjectedContext(client, ctx.directory, sessionID)) {
          contextCollector.markProcessed(sessionID)
          debugLog("session", "Skipping - session already contains persisted Moluoxixi context")
          return
        }

        const context = buildSessionContext(ctx, input)
        debugLog("session", "Built context, length:", context.length)

        const parts = output?.parts || []
        const injectedPart = insertSyntheticTextPart(parts, context, "sessionStart")
        markContextInjected(injectedPart)
        debugLog("session", "Inserted synthetic context part, length:", context.length)

        contextCollector.markProcessed(sessionID)
      } catch (error) {
        debugLog("session", "Error in chat.message:", error.message, error.stack)
      }
    },
  }
}
