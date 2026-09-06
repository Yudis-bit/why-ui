import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ajv } from "ajv";
import { inspectInteractionTool, inspectInteractionMcpOutputSchema, verifyFixTool } from "../mcp-schema.js";
import type { BridgeServer } from "./bridge-server.js";
import type { InspectInteractionRequest, SensorInspectionOptions, VerifyFixRequest, WhyUiErrorCode } from "../types.js";
import { SourceResolver } from "./source-resolver.js";
import { WorkspaceObserver } from "./workspace.js";
import { VerificationService } from "./verification.js";
import { inspectionSlice } from "./mcp-result.js";

const error = (code: WhyUiErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
const reply = (response: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(response) }],
  isError: response.ok === false, structuredContent: response });

export function createMcpServer(bridgeServer: BridgeServer): Server {
  const verification = new VerificationService(bridgeServer);
  const ajv = new Ajv({ strict: true, allErrors: false });
  const validateInput = ajv.compile<InspectInteractionRequest>(inspectInteractionTool.inputSchema);
  const validateInspectOutput = ajv.compile(inspectInteractionMcpOutputSchema);
  const validateVerifyInput = ajv.compile(verifyFixTool.inputSchema);
  const validateVerifyOutput = ajv.compile(verifyFixTool.outputSchema);
  let activeInspections = 0;
  const server = new Server({ name: "why-ui", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { ...inspectInteractionTool, outputSchema: inspectInteractionMcpOutputSchema }, verifyFixTool,
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "inspect_interaction") {
        const input = (args ?? {}) as InspectInteractionRequest;
        if (!validateInput(input)) return reply(error("INVALID_OPTIONS", "Invalid inspect_interaction options."));
        if (activeInspections >= 4) return reply(error("REQUEST_TIMEOUT", "Inspection capacity reached."));
        activeInspections++;
        try {
          const session = bridgeServer.getActiveSession();
          if (input.tabId !== undefined && input.tabId !== session?.tabId) return reply(error("TAB_NOT_CONNECTED", "Requested tab is not armed."));
          const options: SensorInspectionOptions = {};
          if (input.target) options.targetSelector = input.target.selector;
          if (input.maxSamples !== undefined) options.maxSamples = input.maxSamples;
          if (input.includeReactMetadata !== undefined) options.includeReactMetadata = input.includeReactMetadata;
          const capture = await bridgeServer.sendInspectRequest(options);
          if (!capture.ok) return reply(capture);
          if (!("inspectionId" in capture.result)) return reply(error("INVALID_SENSOR_PAYLOAD", "Unexpected browser capture."));
          const sources = await new SourceResolver(bridgeServer.workspace).inspect(capture.result, session?.url);
          const response = { ok: true, result: inspectionSlice(capture.result, sources) };
          if (!validateInspectOutput(response)) return reply(error("INTERNAL_BRIDGE_ERROR", "Invalid inspection projection."));
          if (!session || session.sessionId !== bridgeServer.getActiveSession()?.sessionId) return reply(error("TAB_NOT_CONNECTED", "The armed tab changed during inspection."));
          const baseline = await new WorkspaceObserver(bridgeServer.workspace).baseline(capture.result, session, sources);
          bridgeServer.inspectionStore.setBaseline(capture.result.inspectionId, baseline);
          return reply(response);
        } finally { activeInspections--; }
      }
      if (name === "verify_fix") {
        if (!validateVerifyInput(args ?? {})) return reply(error("INVALID_OPTIONS", "Invalid verify_fix options."));
        const response = await verification.verify(args as unknown as VerifyFixRequest);
        if (!validateVerifyOutput(response)) return reply(error("INTERNAL_BRIDGE_ERROR", "Invalid verification result."));
        return reply(response);
      }
      return reply(error("INVALID_OPTIONS", "Unknown tool requested."));
    } catch {
      // Neither runtime-influenced errors nor local file contents belong in MCP errors.
      return reply(error("INTERNAL_BRIDGE_ERROR", "The local evidence service could not complete this request."));
    }
  });
  return server;
}
