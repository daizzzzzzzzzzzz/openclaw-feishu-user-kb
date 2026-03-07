import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { createFeishuUserKbService } from "../src/service.js";

function createConfig() {
  return {
    channels: {
      feishu: {
        defaultAccount: "main",
        accounts: {
          main: {
            appId: "cli_main",
            appSecret: "secret_main",
          },
          chat: {
            appId: "cli_chat",
            appSecret: "secret_chat",
          },
          default: {
            dmPolicy: "open",
          },
        },
      },
    },
  };
}

async function createTempCredentialDir() {
  return mkdtemp(path.join(os.tmpdir(), "feishu-user-kb-test-"));
}

async function createTempStateRoot() {
  return mkdtemp(path.join(os.tmpdir(), "feishu-user-kb-state-"));
}

async function writeFeishuSessionState(stateRootDir, { agentId = "main", sessionKey, sessionId, senderId }) {
  const effectiveSessionKey = sessionKey ?? "agent:main:feishu:group:oc_test_group";
  const effectiveSessionId = sessionId ?? "session_fallback_1";
  const effectiveSenderId = senderId ?? "ou_owner";
  const sessionsDir = path.join(stateRootDir, "agents", agentId, "sessions");
  const sessionFile = path.join(sessionsDir, `${effectiveSessionId}.jsonl`);

  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Conversation info (untrusted metadata):",
              "```json",
              JSON.stringify(
                {
                  sender_id: effectiveSenderId,
                  sender: effectiveSenderId,
                  conversation_label: "oc_test_group",
                },
                null,
                2,
              ),
              "```",
              "",
              "Sender (untrusted metadata):",
              "```json",
              JSON.stringify(
                {
                  id: effectiveSenderId,
                  label: effectiveSenderId,
                },
                null,
                2,
              ),
              "```",
              "",
              `[message_id: om_test]\n${effectiveSenderId}: hello`,
            ].join("\n"),
          },
        ],
      },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(sessionsDir, "sessions.json"),
    `${JSON.stringify(
      {
        [effectiveSessionKey]: {
          sessionId: effectiveSessionId,
          sessionFile,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    agentId,
    sessionKey: effectiveSessionKey,
    sessionFile,
  };
}

function createClientFactory(overrides = {}) {
  const calls = [];
  const client = {
    authen: {
      oidcAccessToken: {
        create: async (payload) => {
          calls.push({ method: "oidcAccessToken.create", payload });
          return (
            overrides.oidcAccessTokenCreate?.(payload) ?? {
              code: 0,
              data: {
                access_token: "access_token_value",
                refresh_token: "refresh_token_value",
                expires_in: 7200,
                refresh_expires_in: 2592000,
              },
            }
          );
        },
      },
      oidcRefreshAccessToken: {
        create: async (payload) => {
          calls.push({ method: "oidcRefreshAccessToken.create", payload });
          return (
            overrides.oidcRefreshAccessTokenCreate?.(payload) ?? {
              code: 0,
              data: {
                access_token: "refreshed_access_token",
                refresh_token: "refreshed_refresh_token",
                expires_in: 7200,
                refresh_expires_in: 2592000,
              },
            }
          );
        },
      },
      userInfo: {
        get: async (payload, options) => {
          calls.push({ method: "userInfo.get", payload, options });
          return (
            overrides.userInfoGet?.(payload, options) ?? {
              code: 0,
              data: {
                open_id: "ou_owner",
                user_id: "u_owner",
                name: "Owner User",
                email: "owner@example.com",
              },
            }
          );
        },
      },
    },
    wiki: {
      space: {
        list: async (payload, options) => {
          calls.push({ method: "wiki.space.list", payload, options });
          return (
            overrides.spaceList?.(payload, options) ?? {
              code: 0,
              data: {
                items: [{ space_id: "space_1", name: "Knowledge Base" }],
              },
            }
          );
        },
        getNode: async (payload, options) => {
          calls.push({ method: "wiki.space.getNode", payload, options });
          return (
            overrides.getNode?.(payload, options) ?? {
              code: 0,
              data: {
                node: {
                  node_token: payload?.params?.token,
                  obj_token: "doc_token_1",
                  obj_type: "docx",
                  title: "Page",
                },
              },
            }
          );
        },
      },
      spaceNode: {
        list: async (payload, options) => {
          calls.push({ method: "wiki.spaceNode.list", payload, options });
          return overrides.nodeList?.(payload, options) ?? { code: 0, data: { items: [] } };
        },
        create: async (payload, options) => {
          calls.push({ method: "wiki.spaceNode.create", payload, options });
          return (
            overrides.nodeCreate?.(payload, options) ?? {
              code: 0,
              data: {
                node: {
                  node_token: "wiki_node_created",
                  obj_token: "doc_created",
                  obj_type: "docx",
                  title: payload?.data?.title,
                },
              },
            }
          );
        },
        move: async (payload, options) => {
          calls.push({ method: "wiki.spaceNode.move", payload, options });
          return overrides.nodeMove?.(payload, options) ?? { code: 0, data: { node: { node_token: "moved_node" } } };
        },
        updateTitle: async (payload, options) => {
          calls.push({ method: "wiki.spaceNode.updateTitle", payload, options });
          return overrides.updateTitle?.(payload, options) ?? { code: 0, data: {} };
        },
        moveDocsToWiki: async (payload, options) => {
          calls.push({ method: "wiki.spaceNode.moveDocsToWiki", payload, options });
          return (
            overrides.moveDocsToWiki?.(payload, options) ?? {
              code: 0,
              data: {
                task_id: "task_1",
              },
            }
          );
        },
      },
      task: {
        get: async (payload, options) => {
          calls.push({ method: "wiki.task.get", payload, options });
          return (
            overrides.taskGet?.(payload, options) ?? {
              code: 0,
              data: {
                task: {
                  task_id: payload?.path?.task_id,
                  move_result: [],
                },
              },
            }
          );
        },
      },
    },
    docx: {
      document: {
        get: async (payload, options) => {
          calls.push({ method: "docx.document.get", payload, options });
          return (
            overrides.documentGet?.(payload, options) ?? {
              code: 0,
              data: {
                document: {
                  title: "Page",
                  revision_id: 123,
                },
              },
            }
          );
        },
        rawContent: async (payload, options) => {
          calls.push({ method: "docx.document.rawContent", payload, options });
          return (
            overrides.rawContent?.(payload, options) ?? {
              code: 0,
              data: {
                content: "hello",
              },
            }
          );
        },
        convert: async (payload, options) => {
          calls.push({ method: "docx.document.convert", payload, options });
          return (
            overrides.documentConvert?.(payload, options) ?? {
              code: 0,
              data: {
                blocks: [{ block_id: "b1", block_type: 2 }],
                first_level_block_ids: ["b1"],
              },
            }
          );
        },
      },
      documentBlock: {
        list: async (payload, options) => {
          calls.push({ method: "docx.documentBlock.list", payload, options });
          return overrides.blockList?.(payload, options) ?? { code: 0, data: { items: [] } };
        },
      },
      documentBlockChildren: {
        batchDelete: async (payload, options) => {
          calls.push({ method: "docx.documentBlockChildren.batchDelete", payload, options });
          return overrides.batchDelete?.(payload, options) ?? { code: 0, data: {} };
        },
      },
      documentBlockDescendant: {
        create: async (payload, options) => {
          calls.push({ method: "docx.documentBlockDescendant.create", payload, options });
          return (
            overrides.descendantCreate?.(payload, options) ?? {
              code: 0,
              data: {
                children: [{ block_id: "b1" }],
              },
            }
          );
        },
      },
    },
    bitable: {
      app: {
        get: async (payload, options) => {
          calls.push({ method: "bitable.app.get", payload, options });
          return (
            overrides.bitableAppGet?.(payload, options) ?? {
              code: 0,
              data: {
                app: {
                  app_token: payload?.path?.app_token,
                  name: "Bitable App",
                  revision: 1,
                  url: "https://example.com/base/app",
                },
              },
            }
          );
        },
      },
      appTable: {
        list: async (payload, options) => {
          calls.push({ method: "bitable.appTable.list", payload, options });
          return (
            overrides.bitableTableList?.(payload, options) ?? {
              code: 0,
              data: {
                items: [{ table_id: "tbl_default", name: "Default Table" }],
                total: 1,
              },
            }
          );
        },
        create: async (payload, options) => {
          calls.push({ method: "bitable.appTable.create", payload, options });
          return (
            overrides.bitableTableCreate?.(payload, options) ?? {
              code: 0,
              data: {
                table: {
                  table_id: "tbl_created",
                  name: payload?.data?.table?.name ?? "Created Table",
                },
              },
            }
          );
        },
      },
      appTableField: {
        list: async (payload, options) => {
          calls.push({ method: "bitable.appTableField.list", payload, options });
          return (
            overrides.bitableFieldList?.(payload, options) ?? {
              code: 0,
              data: {
                items: [{ field_id: "fld_name", field_name: "Name", type: 1, is_primary: true }],
                total: 1,
              },
            }
          );
        },
        create: async (payload, options) => {
          calls.push({ method: "bitable.appTableField.create", payload, options });
          return (
            overrides.bitableFieldCreate?.(payload, options) ?? {
              code: 0,
              data: {
                field: {
                  field_id: "fld_created",
                  field_name: payload?.data?.field_name ?? "Created Field",
                  type: payload?.data?.type ?? 1,
                },
              },
            }
          );
        },
      },
      appTableRecord: {
        list: async (payload, options) => {
          calls.push({ method: "bitable.appTableRecord.list", payload, options });
          return (
            overrides.bitableRecordList?.(payload, options) ?? {
              code: 0,
              data: {
                items: [{ record_id: "rec_1", fields: { Name: "Item 1" } }],
                total: 1,
                has_more: false,
              },
            }
          );
        },
        get: async (payload, options) => {
          calls.push({ method: "bitable.appTableRecord.get", payload, options });
          return (
            overrides.bitableRecordGet?.(payload, options) ?? {
              code: 0,
              data: {
                record: {
                  record_id: payload?.path?.record_id,
                  fields: { Name: "Item 1" },
                },
              },
            }
          );
        },
        create: async (payload, options) => {
          calls.push({ method: "bitable.appTableRecord.create", payload, options });
          return (
            overrides.bitableRecordCreate?.(payload, options) ?? {
              code: 0,
              data: {
                record: {
                  record_id: "rec_created",
                  fields: payload?.data?.fields ?? {},
                },
              },
            }
          );
        },
        update: async (payload, options) => {
          calls.push({ method: "bitable.appTableRecord.update", payload, options });
          return (
            overrides.bitableRecordUpdate?.(payload, options) ?? {
              code: 0,
              data: {
                record: {
                  record_id: payload?.path?.record_id,
                  fields: payload?.data?.fields ?? {},
                },
              },
            }
          );
        },
      },
    },
  };

  return {
    calls,
    clientFactory: () => client,
  };
}

test("auth_status returns unauthorized with auth url when credentials are missing", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory } = createClientFactory();
  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const result = await service.handleToolAction({}, { action: "auth_status" });
  assert.equal(result.authorized, false);
  assert.equal(result.status, "auth_required");
  assert.match(result.auth_url, /http:\/\/127\.0\.0\.1:18789\/plugins\/feishu-user-kb\/auth\/start\?accountId=main/);
});

test("auth callback writes bound owner credentials", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory } = createClientFactory();
  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  const response = await service.handleAuthCallbackRoute({
    code: "oauth_code_value",
    state,
  });

  assert.equal(response.statusCode, 200);
  const filePath = path.join(credentialDir, "feishu-main-user-auth.json");
  const stored = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(stored.ownerOpenId, "ou_owner");
  assert.equal(stored.ownerUserId, "u_owner");
  assert.equal(stored.accessToken, "access_token_value");
  assert.equal(stored.refreshToken, "refresh_token_value");
});

test("non-owner Feishu requester is denied for secured actions", async () => {
  const credentialDir = await createTempCredentialDir();
  const nowMs = Date.parse("2026-03-06T00:00:00.000Z");
  const { clientFactory } = createClientFactory();
  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
    now: () => nowMs,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });
  const result = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_other",
    },
    { action: "spaces" },
  );

  assert.equal(result.status, "unauthorized_requester");
  assert.equal(result.authorized, false);
});

test("auth_status matches secured action authorization when requester identity is missing", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory } = createClientFactory();
  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const authStatus = await service.handleToolAction(
    {
      messageChannel: "feishu",
    },
    { action: "auth_status" },
  );

  const securedAction = await service.handleToolAction(
    {
      messageChannel: "feishu",
    },
    { action: "spaces" },
  );

  assert.equal(authStatus.status, "unauthorized_requester");
  assert.equal(authStatus.authorized, false);
  assert.match(authStatus.error, /sender identity is missing/i);
  assert.equal(securedAction.status, "unauthorized_requester");
  assert.match(securedAction.error, /sender identity is missing/i);
});

test("missing requesterSenderId falls back to the latest Feishu session sender", async () => {
  const credentialDir = await createTempCredentialDir();
  const stateRootDir = await createTempStateRoot();
  const { clientFactory } = createClientFactory();
  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    stateRootDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });
  const session = await writeFeishuSessionState(stateRootDir, {
    senderId: "ou_owner",
  });

  const authStatus = await service.handleToolAction(
    {
      messageChannel: "feishu",
      agentId: session.agentId,
      sessionKey: session.sessionKey,
    },
    { action: "auth_status" },
  );
  const securedAction = await service.handleToolAction(
    {
      messageChannel: "feishu",
      agentId: session.agentId,
      sessionKey: session.sessionKey,
    },
    { action: "spaces" },
  );

  assert.equal(authStatus.status, "authorized");
  assert.equal(authStatus.authorization_source, "session_transcript");
  assert.equal(securedAction.status, "ok");
});

test("session transcript fallback still rejects non-owner Feishu senders", async () => {
  const credentialDir = await createTempCredentialDir();
  const stateRootDir = await createTempStateRoot();
  const { clientFactory } = createClientFactory();
  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    stateRootDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });
  const session = await writeFeishuSessionState(stateRootDir, {
    senderId: "ou_other",
  });

  const result = await service.handleToolAction(
    {
      messageChannel: "feishu",
      agentId: session.agentId,
      sessionKey: session.sessionKey,
    },
    { action: "spaces" },
  );

  assert.equal(result.status, "unauthorized_requester");
  assert.equal(result.requester_sender_id, "ou_other");
  assert.equal(result.authorization_source, "session_transcript");
});

test("expired token refreshes before action and refresh failure requires reauthorization", async () => {
  const credentialDir = await createTempCredentialDir();
  const baseTime = Date.parse("2026-03-06T00:00:00.000Z");
  let refreshShouldFail = false;
  const { clientFactory, calls } = createClientFactory({
    oidcRefreshAccessTokenCreate: async () => {
      if (refreshShouldFail) {
        throw new Error("refresh failed");
      }
      return {
        code: 0,
        data: {
          access_token: "refreshed_access_token",
          refresh_token: "refreshed_refresh_token",
          expires_in: 7200,
          refresh_expires_in: 2592000,
        },
      };
    },
  });

  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
    now: () => baseTime,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const filePath = path.join(credentialDir, "feishu-main-user-auth.json");
  const staleRecord = JSON.parse(await readFile(filePath, "utf8"));
  staleRecord.accessToken = "stale_access_token";
  staleRecord.refreshToken = "stale_refresh_token";
  staleRecord.accessTokenExpiresAt = new Date(baseTime + 60 * 1000).toISOString();
  await writeFile(filePath, `${JSON.stringify(staleRecord, null, 2)}\n`, "utf8");

  const refreshed = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    { action: "spaces" },
  );

  assert.equal(refreshed.status, "ok");
  assert.ok(calls.some((entry) => entry.method === "oidcRefreshAccessToken.create"));

  refreshShouldFail = true;
  staleRecord.accessToken = "expired_again";
  staleRecord.refreshToken = "broken_refresh_token";
  staleRecord.accessTokenExpiresAt = new Date(baseTime + 60 * 1000).toISOString();
  await writeFile(filePath, `${JSON.stringify(staleRecord, null, 2)}\n`, "utf8");

  const failed = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    { action: "spaces" },
  );

  assert.equal(failed.status, "reauthorization_required");
  const failedStored = JSON.parse(await readFile(filePath, "utf8"));
  assert.match(failedStored.lastError, /refresh failed/);
});

test("node_token resolves to obj_token for write and append actions", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory, calls } = createClientFactory({
    getNode: async (payload) => ({
      code: 0,
      data: {
        node: {
          node_token: payload?.params?.token,
          obj_token: "doc_from_node",
          obj_type: "docx",
          title: "Resolved Page",
        },
      },
    }),
  });

  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const writeResult = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "write_page",
      node_token: "wiki_node_123",
      content: "# Title",
    },
  );
  const appendResult = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "append_page",
      node_token: "wiki_node_123",
      content: "More text",
    },
  );

  assert.equal(writeResult.status, "ok");
  assert.equal(writeResult.obj_token, "doc_from_node");
  assert.equal(appendResult.status, "ok");
  assert.ok(calls.some((entry) => entry.method === "docx.document.convert"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.method === "docx.documentBlockDescendant.create" &&
        entry.payload?.path?.document_id === "doc_from_node",
    ),
  );
});

test("move_doc_to_wiki handles completion and timeout polling paths", async () => {
  const credentialDir = await createTempCredentialDir();
  const taskStates = [
    { code: 0, data: { task: { task_id: "task_done", move_result: [] } } },
    {
      code: 0,
      data: {
        task: {
          task_id: "task_done",
          move_result: [
            {
              status: 0,
              status_msg: "success",
              node: {
                node_token: "wiki_done",
                obj_token: "doc_done",
                obj_type: "docx",
                title: "Done",
              },
            },
          ],
        },
      },
    },
  ];
  const { clientFactory } = createClientFactory({
    moveDocsToWiki: async () => ({
      code: 0,
      data: {
        task_id: "task_done",
      },
    }),
    taskGet: async () => taskStates.shift() ?? { code: 0, data: { task: { task_id: "task_done", move_result: [] } } },
  });

  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
    sleep: async () => {},
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const completed = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "move_doc_to_wiki",
      space_id: "space_1",
      doc_token: "doc_source",
    },
  );

  assert.equal(completed.status, "ok");
  assert.equal(completed.completed, true);
  assert.equal(completed.wait_completed, true);

  const { clientFactory: timeoutClientFactory } = createClientFactory({
    moveDocsToWiki: async () => ({
      code: 0,
      data: {
        task_id: "task_timeout",
      },
    }),
    taskGet: async () => ({
      code: 0,
      data: {
        task: {
          task_id: "task_timeout",
          move_result: [],
        },
      },
    }),
  });

  const timeoutService = createFeishuUserKbService({
    config: createConfig(),
    credentialDir: await createTempCredentialDir(),
    clientFactory: timeoutClientFactory,
    sleep: async () => {},
  });
  const timeoutState = timeoutService.issueAuthState("main");
  await timeoutService.handleAuthCallbackRoute({ code: "oauth_code_value", state: timeoutState });

  const timedOut = await timeoutService.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "move_doc_to_wiki",
      space_id: "space_1",
      doc_token: "doc_source",
    },
  );

  assert.equal(timedOut.status, "ok");
  assert.equal(timedOut.timed_out, true);
  assert.equal(timedOut.wait_completed, false);
});

test("write_page does not clear the document when markdown conversion fails", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory, calls } = createClientFactory({
    documentConvert: async () => ({
      code: 999,
      msg: "convert failed",
      data: {},
    }),
  });

  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const result = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "write_page",
      doc_token: "doc_token_1",
      content: "# Title",
    },
  );

  assert.equal(result.status, "error");
  assert.match(result.error, /convert failed/);
  assert.equal(calls.some((entry) => entry.method === "docx.documentBlock.list"), false);
  assert.equal(calls.some((entry) => entry.method === "docx.documentBlockChildren.batchDelete"), false);
});

test("append_page falls back to chunked markdown conversion for oversized content", async () => {
  const credentialDir = await createTempCredentialDir();
  const longMarkdown = ["# Section One", "A".repeat(300), "# Section Two", "B".repeat(300)].join("\n\n");
  const { clientFactory, calls } = createClientFactory({
    documentConvert: async (payload) => {
      const content = payload?.data?.content ?? "";
      if (content.length > 400) {
        return {
          code: 999,
          msg: "content too large",
          data: {},
        };
      }
      return {
        code: 0,
        data: {
          blocks: [{ block_id: `b${calls.length}`, block_type: 2 }],
          first_level_block_ids: [`b${calls.length}`],
        },
      };
    },
  });

  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const result = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "append_page",
      doc_token: "doc_token_1",
      content: longMarkdown,
    },
  );

  assert.equal(result.status, "ok");
  assert.ok(calls.filter((entry) => entry.method === "docx.document.convert").length >= 2);
});

test("write_page returns docx compatibility warnings for high-risk markdown patterns", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory } = createClientFactory();
  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const result = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "write_page",
      doc_token: "doc_token_1",
      content: [
        "---",
        "owner: ai",
        "---",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "```mermaid",
        "graph TD;",
        "A-->B;",
        "```",
      ].join("\n"),
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.format_profile, "feishu_docx_ai_v1");
  assert.equal(result.compatibility.level, "high_risk");
  assert.equal(result.compatibility.safe_for_docx, false);
  assert.ok(result.compatibility.detected_patterns.includes("frontmatter"));
  assert.ok(result.compatibility.detected_patterns.includes("markdown_table"));
  assert.ok(result.compatibility.detected_patterns.includes("diagram_fence"));
  assert.ok(result.warnings.length >= 3);
});

test("bitable actions resolve node_token to app_token and return metadata and tables", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory, calls } = createClientFactory({
    getNode: async (payload) => ({
      code: 0,
      data: {
        node: {
          node_token: payload?.params?.token,
          obj_token: "app_from_node",
          obj_type: "bitable",
          title: "Ops Tracker",
        },
      },
    }),
    bitableAppGet: async (payload) => ({
      code: 0,
      data: {
        app: {
          app_token: payload?.path?.app_token,
          name: "Ops Tracker",
          revision: 12,
        },
      },
    }),
    bitableTableList: async () => ({
      code: 0,
      data: {
        items: [
          { table_id: "tbl_tasks", name: "Tasks" },
          { table_id: "tbl_faq", name: "FAQ" },
        ],
        total: 2,
      },
    }),
  });

  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const result = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "get_bitable",
      node_token: "wiki_bitable_123",
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.node_token, "wiki_bitable_123");
  assert.equal(result.app.app_token, "app_from_node");
  assert.equal(result.tables.length, 2);
  assert.ok(
    calls.some(
      (entry) =>
        entry.method === "bitable.app.get" && entry.payload?.path?.app_token === "app_from_node",
    ),
  );
});

test("create_bitable and bitable field and record actions use user-mode app token flows", async () => {
  const credentialDir = await createTempCredentialDir();
  const { clientFactory, calls } = createClientFactory({
    nodeCreate: async (payload) => ({
      code: 0,
      data: {
        node: {
          node_token: "wiki_bitable_created",
          obj_token: "app_created",
          obj_type: "bitable",
          title: payload?.data?.title,
        },
      },
    }),
    bitableTableCreate: async (payload) => ({
      code: 0,
      data: {
        table: {
          table_id: "tbl_created",
          name: payload?.data?.table?.name,
        },
      },
    }),
    bitableFieldCreate: async (payload) => ({
      code: 0,
      data: {
        field: {
          field_id: "fld_status",
          field_name: payload?.data?.field_name,
          type: payload?.data?.type,
        },
      },
    }),
    bitableRecordCreate: async (payload) => ({
      code: 0,
      data: {
        record: {
          record_id: "rec_new",
          fields: payload?.data?.fields,
        },
      },
    }),
    bitableRecordUpdate: async (payload) => ({
      code: 0,
      data: {
        record: {
          record_id: payload?.path?.record_id,
          fields: payload?.data?.fields,
        },
      },
    }),
  });

  const service = createFeishuUserKbService({
    config: createConfig(),
    credentialDir,
    clientFactory,
  });

  const state = service.issueAuthState("main");
  await service.handleAuthCallbackRoute({ code: "oauth_code_value", state });

  const createBitable = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "create_bitable",
      space_id: "space_1",
      title: "Project Tracker",
    },
  );

  const createTable = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "create_bitable_table",
      app_token: "app_created",
      table_name: "Tasks",
    },
  );

  const createField = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "create_bitable_field",
      app_token: "app_created",
      table_id: "tbl_created",
      field_name: "Status",
      field_type: 3,
      property: {
        options: [{ name: "Open" }, { name: "Done" }],
      },
    },
  );

  const createRecord = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "create_bitable_record",
      app_token: "app_created",
      table_id: "tbl_created",
      fields: {
        Name: "Ship plugin",
        Status: "Open",
      },
    },
  );

  const updateRecord = await service.handleToolAction(
    {
      messageChannel: "feishu",
      requesterSenderId: "ou_owner",
    },
    {
      action: "update_bitable_record",
      app_token: "app_created",
      table_id: "tbl_created",
      record_id: "rec_new",
      fields: {
        Status: "Done",
      },
    },
  );

  assert.equal(createBitable.status, "ok");
  assert.equal(createBitable.app_token, "app_created");
  assert.equal(createTable.table.table_id, "tbl_created");
  assert.equal(createField.field.field_id, "fld_status");
  assert.equal(createRecord.record.record_id, "rec_new");
  assert.equal(updateRecord.record.record_id, "rec_new");
  assert.ok(
    calls.some(
      (entry) =>
        entry.method === "wiki.spaceNode.create" && entry.payload?.data?.obj_type === "bitable",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.method === "bitable.appTableRecord.update" &&
        entry.payload?.path?.app_token === "app_created" &&
        entry.payload?.path?.table_id === "tbl_created",
    ),
  );
});
