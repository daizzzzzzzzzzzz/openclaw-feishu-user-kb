import { createToolResponse } from "./src/service.js";
import { FEISHU_USER_KB_PROMPT_GUIDANCE } from "./src/prompt-guidance.js";
import { FEISHU_USER_KB_SCHEMA } from "./src/schema.js";
import { createFeishuUserKbService } from "./src/service.js";

const plugin = {
  id: "feishu-user-kb",
  name: "Feishu User KB",
  description: "Feishu knowledge base operations via user_access_token.",
  register(api) {
    const service = createFeishuUserKbService({
      config: api.config,
      pluginConfig: api.pluginConfig,
      logger: api.logger,
    });

    api.on("gateway_start", ({ port }) => {
      service.setGatewayPort(port);
    });

    api.on("gateway_stop", () => {
      service.setGatewayPort(undefined);
    });

    api.registerTool((ctx) => ({
      name: "feishu_user_kb",
      label: "Feishu User KB",
      description:
        "Feishu knowledge base and bitable operations via user_access_token. Actions: auth_status, start_auth, spaces, nodes, get_node, create_page, read_page, write_page, append_page, rename_node, move_node, move_doc_to_wiki, get_task, get_bitable, create_bitable, list_bitable_tables, create_bitable_table, list_bitable_fields, create_bitable_field, list_bitable_records, get_bitable_record, create_bitable_record, update_bitable_record.",
      parameters: FEISHU_USER_KB_SCHEMA,
      async execute(_toolCallId, params) {
        try {
          return createToolResponse(await service.handleToolAction(ctx, params ?? {}));
        } catch (error) {
          return createToolResponse({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }));

    api.registerHttpRoute({
      path: "/plugins/feishu-user-kb/auth/start",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const result = await service.handleAuthStartRoute({
          accountId: url.searchParams.get("accountId"),
        });
        res.statusCode = result.statusCode;
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          res.setHeader(name, value);
        }
        res.end(result.body ?? "");
      },
    });

    api.registerHttpRoute({
      path: "/plugins/feishu-user-kb/auth/callback",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const result = await service.handleAuthCallbackRoute({
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
        });
        res.statusCode = result.statusCode;
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          res.setHeader(name, value);
        }
        res.end(result.body ?? "");
      },
    });

    api.on("before_prompt_build", async () => ({
      prependContext: FEISHU_USER_KB_PROMPT_GUIDANCE,
    }));
  },
};

export default plugin;
