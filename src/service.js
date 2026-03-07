import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import {
  createBitableField,
  createBitableRecord,
  createBitableTable,
  getBitableApp,
  getBitableRecord,
  listBitableFields,
  listBitableRecords,
  listBitableTables,
  resolveBitableAppTokenFromNode,
  updateBitableRecord,
} from "./bitable.js";
import {
  buildAuthorizeUrl,
  buildAuthStartUrl,
  buildCallbackUrl,
  buildGatewayBaseUrl,
  createBaseClient,
  resolveAccountById,
  resolveToolAccount,
} from "./accounts.js";
import {
  appendMarkdownToDocument,
  readDocument,
  resolveDocTokenFromNode,
  writeMarkdownToDocument,
} from "./docx.js";
import {
  readCredentialRecord,
  serializeError,
  withAccountLock,
  writeCredentialRecord,
} from "./store.js";

const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MOVE_TASK_POLL_ATTEMPTS = 30;
const MOVE_TASK_POLL_INTERVAL_MS = 2000;
const CONVERSATION_INFO_BLOCK_RE =
  /Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i;
const SENDER_INFO_BLOCK_RE = /Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i;

function trimString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoFromNow(nowMs, ttlSeconds) {
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return null;
  }
  return new Date(nowMs + ttlSeconds * 1000).toISOString();
}

function createHtmlPage(title, body) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    "</head>",
    '<body style="font-family:Segoe UI,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5;">',
    `<h1>${title}</h1>`,
    `<p>${body}</p>`,
    "</body>",
    "</html>",
  ].join("");
}

function normalizeTaskResult(task) {
  const moveResult = Array.isArray(task?.move_result) ? task.move_result : [];
  return {
    task_id: task?.task_id ?? null,
    completed: moveResult.length > 0,
    move_result: moveResult.map((entry) => ({
      status: entry?.status ?? null,
      status_msg: entry?.status_msg ?? null,
      node: {
        space_id: entry?.node?.space_id ?? null,
        node_token: entry?.node?.node_token ?? null,
        obj_token: entry?.node?.obj_token ?? null,
        obj_type: entry?.node?.obj_type ?? null,
        title: entry?.node?.title ?? null,
        parent_node_token: entry?.node?.parent_node_token ?? null,
      },
    })),
  };
}

function needsRefresh(record, nowMs) {
  const accessTokenExpiresAt = trimString(record?.accessTokenExpiresAt);
  if (!accessTokenExpiresAt) {
    return true;
  }
  const expiryMs = Date.parse(accessTokenExpiresAt);
  if (!Number.isFinite(expiryMs)) {
    return true;
  }
  return expiryMs - nowMs <= ACCESS_TOKEN_REFRESH_SKEW_MS;
}

function getNormalizedRequesterSenderId(ctx) {
  return trimString(ctx?.requesterSenderId);
}

function extractTextParts(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((entry) => entry?.type === "text" && typeof entry?.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function extractJsonBlockValue(text, pattern, keys) {
  if (!text) {
    return null;
  }
  const match = text.match(pattern);
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]);
    for (const key of keys) {
      const value = trimString(parsed?.[key]);
      if (value) {
        return value;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractMirroredFeishuSenderId(text) {
  return (
    extractJsonBlockValue(text, CONVERSATION_INFO_BLOCK_RE, ["sender_id", "sender"]) ??
    extractJsonBlockValue(text, SENDER_INFO_BLOCK_RE, ["id", "label"])
  );
}

function resolveAgentIdForSession(ctx) {
  const explicitAgentId = trimString(ctx?.agentId);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const sessionKey = trimString(ctx?.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/^agent:([^:]+)/);
  return trimString(match?.[1]);
}

async function resolveRequesterSenderIdFromSessionTranscript(stateRootDir, ctx) {
  const sessionKey = trimString(ctx?.sessionKey);
  if (!sessionKey || !sessionKey.includes(":feishu:")) {
    return null;
  }

  const agentId = resolveAgentIdForSession(ctx);
  if (!agentId) {
    return null;
  }

  const sessionsDir = path.join(stateRootDir, "agents", agentId, "sessions");
  const sessionsIndexPath = path.join(sessionsDir, "sessions.json");
  let sessionsIndex;
  try {
    sessionsIndex = JSON.parse(await readFile(sessionsIndexPath, "utf8"));
  } catch {
    return null;
  }

  const sessionEntry = sessionsIndex?.[sessionKey];
  const sessionFile =
    trimString(sessionEntry?.sessionFile) ??
    (trimString(sessionEntry?.sessionId)
      ? path.join(sessionsDir, `${trimString(sessionEntry.sessionId)}.jsonl`)
      : null);
  if (!sessionFile) {
    return null;
  }

  let transcriptContent;
  try {
    transcriptContent = await readFile(sessionFile, "utf8");
  } catch {
    return null;
  }

  const lines = transcriptContent.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry?.message?.role !== "user") {
      continue;
    }
    return extractMirroredFeishuSenderId(extractTextParts(entry.message.content));
  }

  return null;
}

async function getRequesterAuthorization(ctx, ownerOpenId, accountId, stateRootDir, logger) {
  if (trimString(ctx?.messageChannel) !== "feishu") {
    return {
      failure: {
        status: "unauthorized_requester",
        authorized: false,
        account_id: accountId,
        owner_open_id: ownerOpenId ?? null,
        error: "This tool only permits knowledge base actions from Feishu message context.",
      },
    };
  }

  let requesterSenderId = getNormalizedRequesterSenderId(ctx);
  let authorizationSource = requesterSenderId ? "tool_context" : null;
  if (!requesterSenderId) {
    requesterSenderId = await resolveRequesterSenderIdFromSessionTranscript(stateRootDir, ctx);
    if (requesterSenderId) {
      authorizationSource = "session_transcript";
      logger.warn?.(
        `feishu-user-kb: recovered requesterSenderId from session transcript for ${trimString(ctx?.sessionKey) ?? "unknown-session"}`,
      );
    }
  }

  if (!requesterSenderId) {
    return {
      failure: {
        status: "unauthorized_requester",
        authorized: false,
        account_id: accountId,
        owner_open_id: ownerOpenId ?? null,
        error: "Trusted Feishu sender identity is missing from the current tool context.",
      },
    };
  }

  if (ownerOpenId && requesterSenderId !== ownerOpenId) {
    return {
      failure: {
        status: "unauthorized_requester",
        authorized: false,
        account_id: accountId,
        owner_open_id: ownerOpenId,
        requester_sender_id: requesterSenderId,
        authorization_source: authorizationSource,
      },
    };
  }

  return {
    failure: null,
    requesterSenderId,
    authorizationSource: authorizationSource ?? "tool_context",
  };
}

export function createToolResponse(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function createFeishuUserKbService({
  config,
  pluginConfig,
  logger = console,
  credentialDir,
  stateRootDir = path.join(os.homedir(), ".openclaw"),
  clientFactory = createBaseClient,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const authStateStore = new Map();
  let gatewayPort;

  function getGatewayBase() {
    return buildGatewayBaseUrl(pluginConfig, gatewayPort);
  }

  function getCallbackUrl() {
    return buildCallbackUrl(getGatewayBase());
  }

  function cleanupExpiredAuthStates() {
    const currentTime = now();
    for (const [state, entry] of authStateStore.entries()) {
      if (!entry || entry.expiresAt <= currentTime) {
        authStateStore.delete(state);
      }
    }
  }

  function issueAuthState(accountId) {
    cleanupExpiredAuthStates();
    const state = crypto.randomBytes(24).toString("hex");
    authStateStore.set(state, {
      accountId,
      expiresAt: now() + AUTH_STATE_TTL_MS,
    });
    return state;
  }

  function consumeAuthState(state) {
    cleanupExpiredAuthStates();
    const stateValue = trimString(state);
    if (!stateValue) {
      return null;
    }
    const entry = authStateStore.get(stateValue);
    authStateStore.delete(stateValue);
    if (!entry || entry.expiresAt <= now()) {
      return null;
    }
    return entry.accountId;
  }

  function resolveToolAccountForContext(ctx) {
    return resolveToolAccount(config, ctx?.agentAccountId);
  }

  function authUrlForAccount(accountId) {
    return buildAuthStartUrl(getGatewayBase(), accountId);
  }

  async function refreshCredentialRecord(account, currentRecord) {
    return withAccountLock(account.accountId, async () => {
      const latestRecord = (await readCredentialRecord(account.accountId, credentialDir)) ?? currentRecord;
      if (!latestRecord?.refreshToken) {
        throw new Error("refresh_token is missing");
      }
      if (!needsRefresh(latestRecord, now())) {
        return latestRecord;
      }

      const client = clientFactory(account);
      try {
        const refreshResponse = await client.authen.oidcRefreshAccessToken.create({
          data: {
            grant_type: "refresh_token",
            refresh_token: latestRecord.refreshToken,
          },
        });
        if (refreshResponse?.code !== 0 || !refreshResponse?.data?.access_token) {
          throw new Error(refreshResponse?.msg || "Failed to refresh Feishu user access token");
        }

        const refreshedRecord = {
          ...latestRecord,
          accessToken: refreshResponse.data.access_token,
          refreshToken: trimString(refreshResponse?.data?.refresh_token) ?? latestRecord.refreshToken,
          accessTokenExpiresAt: isoFromNow(now(), refreshResponse?.data?.expires_in),
          refreshTokenExpiresAt:
            isoFromNow(now(), refreshResponse?.data?.refresh_expires_in) ??
            latestRecord.refreshTokenExpiresAt,
          updatedAt: new Date(now()).toISOString(),
          lastError: null,
        };
        await writeCredentialRecord(account.accountId, credentialDir, refreshedRecord);
        return refreshedRecord;
      } catch (error) {
        const failedRecord = {
          ...latestRecord,
          updatedAt: new Date(now()).toISOString(),
          lastError: serializeError(error),
        };
        await writeCredentialRecord(account.accountId, credentialDir, failedRecord);
        throw error;
      }
    });
  }

  async function getAuthStatusResult(ctx) {
    const account = resolveToolAccountForContext(ctx);
    const authUrl = authUrlForAccount(account.accountId);
    const existingRecord = await readCredentialRecord(account.accountId, credentialDir);
    if (!existingRecord?.ownerOpenId || !existingRecord?.accessToken || !existingRecord?.refreshToken) {
      return {
        status: "auth_required",
        authorized: false,
        account_id: account.accountId,
        auth_url: authUrl,
        callback_url: getCallbackUrl(),
      };
    }

    const requesterAuthorization = await getRequesterAuthorization(
      ctx,
      existingRecord.ownerOpenId,
      account.accountId,
      stateRootDir,
      logger,
    );
    if (requesterAuthorization.failure) {
      return requesterAuthorization.failure;
    }

    try {
      const effectiveRecord = needsRefresh(existingRecord, now())
        ? await refreshCredentialRecord(account, existingRecord)
        : existingRecord;

      return {
        status: "authorized",
        authorized: true,
        account_id: account.accountId,
        owner_open_id: effectiveRecord.ownerOpenId,
        owner_user_id: effectiveRecord.ownerUserId,
        name: effectiveRecord.name,
        email: effectiveRecord.email,
        authorization_source: requesterAuthorization.authorizationSource,
        auth_url: authUrl,
        callback_url: getCallbackUrl(),
      };
    } catch (error) {
      return {
        status: "reauthorization_required",
        authorized: false,
        account_id: account.accountId,
        auth_url: authUrl,
        callback_url: getCallbackUrl(),
        error: serializeError(error),
      };
    }
  }

  async function getAuthorizedSession(ctx) {
    const account = resolveToolAccountForContext(ctx);
    const authUrl = authUrlForAccount(account.accountId);
    const existingRecord = await readCredentialRecord(account.accountId, credentialDir);
    if (!existingRecord?.ownerOpenId || !existingRecord?.accessToken || !existingRecord?.refreshToken) {
      return {
        ok: false,
        result: {
          status: "auth_required",
          authorized: false,
          account_id: account.accountId,
          auth_url: authUrl,
          callback_url: getCallbackUrl(),
        },
      };
    }

    const requesterAuthorization = await getRequesterAuthorization(
      ctx,
      existingRecord.ownerOpenId,
      account.accountId,
      stateRootDir,
      logger,
    );
    if (requesterAuthorization.failure) {
      return {
        ok: false,
        result: requesterAuthorization.failure,
      };
    }

    try {
      const effectiveRecord = needsRefresh(existingRecord, now())
        ? await refreshCredentialRecord(account, existingRecord)
        : existingRecord;
      return {
        ok: true,
        account,
        authUrl,
        client: clientFactory(account),
        accessToken: effectiveRecord.accessToken,
      };
    } catch (error) {
      return {
        ok: false,
        result: {
          status: "reauthorization_required",
          authorized: false,
          account_id: account.accountId,
          auth_url: authUrl,
          callback_url: getCallbackUrl(),
          error: serializeError(error),
        },
      };
    }
  }

  async function resolveDocumentTarget(client, accessToken, params) {
    const directDocToken = trimString(params?.doc_token);
    if (directDocToken) {
      return {
        docToken: directDocToken,
        node: null,
      };
    }

    const nodeToken = trimString(params?.node_token);
    if (!nodeToken) {
      throw new Error("Either doc_token or node_token is required");
    }
    return resolveDocTokenFromNode(client, accessToken, nodeToken);
  }

  async function resolveBitableTarget(client, accessToken, params) {
    const directAppToken = trimString(params?.app_token);
    if (directAppToken) {
      return {
        appToken: directAppToken,
        node: null,
      };
    }

    const nodeToken = trimString(params?.node_token);
    if (!nodeToken) {
      throw new Error("Either app_token or node_token is required");
    }
    return resolveBitableAppTokenFromNode(client, accessToken, nodeToken);
  }

  async function readTask(client, accessToken, taskId) {
    const taskResponse = await client.wiki.task.get(
      {
        params: {
          task_type: "move",
        },
        path: {
          task_id: taskId,
        },
      },
      lark.withUserAccessToken(accessToken),
    );
    if (taskResponse?.code !== 0) {
      throw new Error(taskResponse?.msg || "Failed to read wiki task");
    }
    return normalizeTaskResult(taskResponse?.data?.task);
  }

  async function pollTaskUntilComplete(client, accessToken, taskId) {
    let latestTask = {
      task_id: taskId,
      completed: false,
      move_result: [],
    };
    for (let attempt = 0; attempt < MOVE_TASK_POLL_ATTEMPTS; attempt += 1) {
      latestTask = await readTask(client, accessToken, taskId);
      if (latestTask.completed) {
        return {
          ...latestTask,
          wait_completed: true,
          timed_out: false,
        };
      }
      if (attempt < MOVE_TASK_POLL_ATTEMPTS - 1) {
        await sleep(MOVE_TASK_POLL_INTERVAL_MS);
      }
    }
    return {
      ...latestTask,
      wait_completed: false,
      timed_out: true,
    };
  }

  async function handleAuthorizedAction(ctx, params) {
    const session = await getAuthorizedSession(ctx);
    if (!session.ok) {
      return session.result;
    }

    const { account, client, accessToken } = session;
    switch (params.action) {
      case "spaces": {
        const response = await client.wiki.space.list({}, lark.withUserAccessToken(accessToken));
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to list Feishu knowledge spaces");
        }
        return {
          status: "ok",
          account_id: account.accountId,
          spaces:
            response?.data?.items?.map((space) => ({
              space_id: space?.space_id ?? null,
              name: space?.name ?? null,
              description: space?.description ?? null,
              visibility: space?.visibility ?? null,
            })) ?? [],
        };
      }
      case "nodes": {
        const spaceId = trimString(params?.space_id);
        if (!spaceId) {
          throw new Error("space_id is required");
        }
        const response = await client.wiki.spaceNode.list(
          {
            path: {
              space_id: spaceId,
            },
            params: trimString(params?.parent_node_token)
              ? {
                  parent_node_token: trimString(params.parent_node_token),
                }
              : undefined,
          },
          lark.withUserAccessToken(accessToken),
        );
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to list Feishu knowledge nodes");
        }
        return {
          status: "ok",
          account_id: account.accountId,
          space_id: spaceId,
          nodes:
            response?.data?.items?.map((node) => ({
              node_token: node?.node_token ?? null,
              obj_token: node?.obj_token ?? null,
              obj_type: node?.obj_type ?? null,
              title: node?.title ?? null,
              has_child: node?.has_child ?? null,
            })) ?? [],
        };
      }
      case "get_node": {
        const nodeToken = trimString(params?.node_token);
        if (!nodeToken) {
          throw new Error("node_token is required");
        }
        const response = await client.wiki.space.getNode(
          {
            params: {
              token: nodeToken,
            },
          },
          lark.withUserAccessToken(accessToken),
        );
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to get Feishu knowledge node");
        }
        const node = response?.data?.node;
        return {
          status: "ok",
          account_id: account.accountId,
          node: {
            node_token: node?.node_token ?? null,
            space_id: node?.space_id ?? null,
            obj_token: node?.obj_token ?? null,
            obj_type: node?.obj_type ?? null,
            title: node?.title ?? null,
            parent_node_token: node?.parent_node_token ?? null,
            has_child: node?.has_child ?? null,
          },
        };
      }
      case "create_page": {
        const spaceId = trimString(params?.space_id);
        const title = trimString(params?.title);
        if (!spaceId || !title) {
          throw new Error("space_id and title are required");
        }
        const response = await client.wiki.spaceNode.create(
          {
            path: {
              space_id: spaceId,
            },
            data: {
              obj_type: "docx",
              node_type: "origin",
              title,
              parent_node_token: trimString(params?.parent_node_token) ?? undefined,
            },
          },
          lark.withUserAccessToken(accessToken),
        );
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to create Feishu knowledge page");
        }
        return {
          status: "ok",
          account_id: account.accountId,
          space_id: spaceId,
          node_token: response?.data?.node?.node_token ?? null,
          obj_token: response?.data?.node?.obj_token ?? null,
          obj_type: response?.data?.node?.obj_type ?? null,
          title: response?.data?.node?.title ?? title,
        };
      }
      case "read_page": {
        const { docToken, node } = await resolveDocumentTarget(client, accessToken, params);
        const document = await readDocument(client, accessToken, docToken);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          obj_token: docToken,
          ...document,
        };
      }
      case "write_page": {
        const content = trimString(params?.content);
        if (!content) {
          throw new Error("content is required");
        }
        const { docToken, node } = await resolveDocumentTarget(client, accessToken, params);
        const result = await writeMarkdownToDocument(client, accessToken, docToken, content);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          obj_token: docToken,
          ...result,
        };
      }
      case "append_page": {
        const content = trimString(params?.content);
        if (!content) {
          throw new Error("content is required");
        }
        const { docToken, node } = await resolveDocumentTarget(client, accessToken, params);
        const result = await appendMarkdownToDocument(client, accessToken, docToken, content);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          obj_token: docToken,
          success: true,
          ...result,
        };
      }
      case "rename_node": {
        const spaceId = trimString(params?.space_id);
        const nodeToken = trimString(params?.node_token);
        const title = trimString(params?.title);
        if (!spaceId || !nodeToken || !title) {
          throw new Error("space_id, node_token, and title are required");
        }
        const response = await client.wiki.spaceNode.updateTitle(
          {
            path: {
              space_id: spaceId,
              node_token: nodeToken,
            },
            data: {
              title,
            },
          },
          lark.withUserAccessToken(accessToken),
        );
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to rename Feishu knowledge node");
        }
        return {
          status: "ok",
          account_id: account.accountId,
          success: true,
          space_id: spaceId,
          node_token: nodeToken,
          title,
        };
      }
      case "move_node": {
        const spaceId = trimString(params?.space_id);
        const nodeToken = trimString(params?.node_token);
        if (!spaceId || !nodeToken) {
          throw new Error("space_id and node_token are required");
        }
        const response = await client.wiki.spaceNode.move(
          {
            path: {
              space_id: spaceId,
              node_token: nodeToken,
            },
            data: {
              target_space_id: trimString(params?.target_space_id) ?? spaceId,
              target_parent_token: trimString(params?.target_parent_token) ?? undefined,
            },
          },
          lark.withUserAccessToken(accessToken),
        );
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to move Feishu knowledge node");
        }
        return {
          status: "ok",
          account_id: account.accountId,
          success: true,
          space_id: trimString(params?.target_space_id) ?? spaceId,
          node_token: response?.data?.node?.node_token ?? nodeToken,
        };
      }
      case "move_doc_to_wiki": {
        const spaceId = trimString(params?.space_id);
        const objToken = trimString(params?.obj_token) ?? trimString(params?.doc_token);
        if (!spaceId || !objToken) {
          throw new Error("space_id and obj_token or doc_token are required");
        }
        const response = await client.wiki.spaceNode.moveDocsToWiki(
          {
            path: {
              space_id: spaceId,
            },
            data: {
              parent_wiki_token: trimString(params?.parent_node_token) ?? undefined,
              obj_type: trimString(params?.obj_type) ?? "docx",
              obj_token: objToken,
              apply: true,
            },
          },
          lark.withUserAccessToken(accessToken),
        );
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to move Feishu document to knowledge base");
        }

        const taskId = trimString(response?.data?.task_id);
        const baseResult = {
          status: "ok",
          account_id: account.accountId,
          space_id: spaceId,
          task_id: taskId,
          wiki_token: trimString(response?.data?.wiki_token),
          applied: response?.data?.applied ?? null,
        };

        if (params?.wait_for_completion === false || !taskId) {
          return baseResult;
        }

        return {
          ...baseResult,
          ...(await pollTaskUntilComplete(client, accessToken, taskId)),
        };
      }
      case "get_task": {
        const taskId = trimString(params?.task_id);
        if (!taskId) {
          throw new Error("task_id is required");
        }
        return {
          status: "ok",
          account_id: account.accountId,
          ...(await readTask(client, accessToken, taskId)),
        };
      }
      case "get_bitable": {
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          ...(await getBitableApp(client, accessToken, appToken)),
          ...(await listBitableTables(client, accessToken, appToken)),
        };
      }
      case "create_bitable": {
        const spaceId = trimString(params?.space_id);
        const title = trimString(params?.title);
        if (!spaceId || !title) {
          throw new Error("space_id and title are required");
        }
        const response = await client.wiki.spaceNode.create(
          {
            path: {
              space_id: spaceId,
            },
            data: {
              obj_type: "bitable",
              node_type: "origin",
              title,
              parent_node_token: trimString(params?.parent_node_token) ?? undefined,
            },
          },
          lark.withUserAccessToken(accessToken),
        );
        if (response?.code !== 0) {
          throw new Error(response?.msg || "Failed to create Feishu knowledge bitable");
        }
        return {
          status: "ok",
          account_id: account.accountId,
          space_id: spaceId,
          node_token: response?.data?.node?.node_token ?? null,
          app_token: response?.data?.node?.obj_token ?? null,
          obj_token: response?.data?.node?.obj_token ?? null,
          obj_type: response?.data?.node?.obj_type ?? null,
          title: response?.data?.node?.title ?? title,
        };
      }
      case "list_bitable_tables": {
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          ...(await listBitableTables(client, accessToken, appToken)),
        };
      }
      case "create_bitable_table": {
        const tableName = trimString(params?.table_name);
        if (!tableName) {
          throw new Error("table_name is required");
        }
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          ...(await createBitableTable(
            client,
            accessToken,
            appToken,
            tableName,
            trimString(params?.default_view_name),
            Array.isArray(params?.table_fields) ? params.table_fields : undefined,
          )),
        };
      }
      case "list_bitable_fields": {
        const tableId = trimString(params?.table_id);
        if (!tableId) {
          throw new Error("table_id is required");
        }
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          table_id: tableId,
          ...(await listBitableFields(client, accessToken, appToken, tableId)),
        };
      }
      case "create_bitable_field": {
        const tableId = trimString(params?.table_id);
        const fieldName = trimString(params?.field_name);
        if (!tableId || !fieldName || typeof params?.field_type !== "number") {
          throw new Error("table_id, field_name, and field_type are required");
        }
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          table_id: tableId,
          ...(await createBitableField(
            client,
            accessToken,
            appToken,
            tableId,
            fieldName,
            params.field_type,
            params?.property && typeof params.property === "object" ? params.property : undefined,
          )),
        };
      }
      case "list_bitable_records": {
        const tableId = trimString(params?.table_id);
        if (!tableId) {
          throw new Error("table_id is required");
        }
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          table_id: tableId,
          ...(await listBitableRecords(
            client,
            accessToken,
            appToken,
            tableId,
            typeof params?.page_size === "number" ? params.page_size : undefined,
            trimString(params?.page_token),
          )),
        };
      }
      case "get_bitable_record": {
        const tableId = trimString(params?.table_id);
        const recordId = trimString(params?.record_id);
        if (!tableId || !recordId) {
          throw new Error("table_id and record_id are required");
        }
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          table_id: tableId,
          ...(await getBitableRecord(client, accessToken, appToken, tableId, recordId)),
        };
      }
      case "create_bitable_record": {
        const tableId = trimString(params?.table_id);
        if (!tableId || !params?.fields || typeof params.fields !== "object" || Array.isArray(params.fields)) {
          throw new Error("table_id and fields are required");
        }
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          table_id: tableId,
          ...(await createBitableRecord(client, accessToken, appToken, tableId, params.fields)),
        };
      }
      case "update_bitable_record": {
        const tableId = trimString(params?.table_id);
        const recordId = trimString(params?.record_id);
        if (
          !tableId ||
          !recordId ||
          !params?.fields ||
          typeof params.fields !== "object" ||
          Array.isArray(params.fields)
        ) {
          throw new Error("table_id, record_id, and fields are required");
        }
        const { appToken, node } = await resolveBitableTarget(client, accessToken, params);
        return {
          status: "ok",
          account_id: account.accountId,
          node_token: node?.node_token ?? trimString(params?.node_token),
          app_token: appToken,
          table_id: tableId,
          ...(await updateBitableRecord(client, accessToken, appToken, tableId, recordId, params.fields)),
        };
      }
      default:
        return {
          status: "error",
          error: `Unknown action: ${String(params?.action)}`,
        };
    }
  }

  return {
    setGatewayPort(port) {
      gatewayPort = typeof port === "number" ? port : undefined;
    },

    issueAuthState,

    async handleToolAction(ctx, rawParams) {
      const params = rawParams && typeof rawParams === "object" ? rawParams : {};
      switch (params.action) {
        case "auth_status":
          return getAuthStatusResult(ctx);
        case "start_auth":
          return getAuthStatusResult(ctx);
        default:
          try {
            return await handleAuthorizedAction(ctx, params);
          } catch (error) {
            return {
              status: "error",
              error: serializeError(error),
            };
          }
      }
    },

    async handleAuthStartRoute({ accountId }) {
      try {
        const account = resolveAccountById(config, accountId);
        const state = issueAuthState(account.accountId);
        return {
          statusCode: 302,
          headers: {
            Location: buildAuthorizeUrl({
              appId: account.appId,
              redirectUri: getCallbackUrl(),
              state,
            }),
          },
          body: "",
        };
      } catch (error) {
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
          body: createHtmlPage("Authorization failed", serializeError(error)),
        };
      }
    },

    async handleAuthCallbackRoute({ code, state }) {
      const authorizationCode = trimString(code);
      const accountId = consumeAuthState(state);
      if (!authorizationCode || !accountId) {
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
          body: createHtmlPage(
            "Authorization failed",
            "The Feishu OAuth callback is missing a valid code or state. Start authorization again from the bot.",
          ),
        };
      }

      try {
        const account = resolveAccountById(config, accountId);
        await withAccountLock(account.accountId, async () => {
          const client = clientFactory(account);
          const tokenResponse = await client.authen.oidcAccessToken.create({
            data: {
              grant_type: "authorization_code",
              code: authorizationCode,
            },
          });
          if (tokenResponse?.code !== 0 || !tokenResponse?.data?.access_token) {
            throw new Error(tokenResponse?.msg || "Failed to exchange Feishu authorization code");
          }

          const accessToken = tokenResponse.data.access_token;
          const userInfoResponse = await client.authen.userInfo.get({}, lark.withUserAccessToken(accessToken));
          if (userInfoResponse?.code !== 0 || !userInfoResponse?.data?.open_id) {
            throw new Error(userInfoResponse?.msg || "Failed to read Feishu user profile");
          }

          const existingRecord = await readCredentialRecord(account.accountId, credentialDir);
          const incomingOpenId = trimString(userInfoResponse?.data?.open_id);
          if (existingRecord?.ownerOpenId && existingRecord.ownerOpenId !== incomingOpenId) {
            throw new Error(
              `This account is already bound to ${existingRecord.ownerOpenId}. Single-user mode does not allow a different Feishu user to replace it.`,
            );
          }

          await writeCredentialRecord(account.accountId, credentialDir, {
            version: 1,
            ownerOpenId: incomingOpenId,
            ownerUserId: trimString(userInfoResponse?.data?.user_id),
            name: trimString(userInfoResponse?.data?.name),
            email:
              trimString(userInfoResponse?.data?.email) ??
              trimString(userInfoResponse?.data?.enterprise_email),
            accessToken,
            refreshToken: trimString(tokenResponse?.data?.refresh_token),
            accessTokenExpiresAt: isoFromNow(now(), tokenResponse?.data?.expires_in),
            refreshTokenExpiresAt: isoFromNow(now(), tokenResponse?.data?.refresh_expires_in),
            grantedAt: existingRecord?.grantedAt ?? new Date(now()).toISOString(),
            updatedAt: new Date(now()).toISOString(),
            lastError: null,
          });
        });

        return {
          statusCode: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
          body: createHtmlPage(
            "Authorization complete",
            `Feishu user authorization succeeded for account "${accountId}". You can return to Feishu and ask the bot to continue.`,
          ),
        };
      } catch (error) {
        logger.warn?.(`feishu-user-kb auth callback failed: ${serializeError(error)}`);
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
          body: createHtmlPage("Authorization failed", serializeError(error)),
        };
      }
    },
  };
}
