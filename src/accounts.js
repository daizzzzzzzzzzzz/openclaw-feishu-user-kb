import * as lark from "@larksuiteoapi/node-sdk";

export const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:18789";
export const FEISHU_USER_KB_PLUGIN_ID = "feishu-user-kb";
export const FEISHU_AUTHORIZE_ENDPOINT = "https://open.feishu.cn/open-apis/authen/v1/index";

function trimString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getFeishuConfig(config) {
  return config?.channels?.feishu && typeof config.channels.feishu === "object"
    ? config.channels.feishu
    : {};
}

function mergeAccountConfig(config, accountId) {
  const feishuConfig = getFeishuConfig(config);
  const { accounts, defaultAccount, ...baseConfig } = feishuConfig;
  const accountConfig =
    accounts &&
    typeof accounts === "object" &&
    accounts[accountId] &&
    typeof accounts[accountId] === "object"
      ? accounts[accountId]
      : {};
  return {
    ...baseConfig,
    ...accountConfig,
  };
}

function hasCredentials(accountConfig) {
  return Boolean(trimString(accountConfig?.appId) && trimString(accountConfig?.appSecret));
}

export function listConfiguredAccountIds(config) {
  const feishuConfig = getFeishuConfig(config);
  const accounts =
    feishuConfig?.accounts && typeof feishuConfig.accounts === "object" ? feishuConfig.accounts : {};
  return Object.keys(accounts).filter((accountId) => hasCredentials(mergeAccountConfig(config, accountId)));
}

export function resolveToolAccountId(config, agentAccountId) {
  const explicitAccountId = trimString(agentAccountId);
  if (explicitAccountId && hasCredentials(mergeAccountConfig(config, explicitAccountId))) {
    return explicitAccountId;
  }

  const defaultAccountId = trimString(getFeishuConfig(config)?.defaultAccount);
  if (defaultAccountId && hasCredentials(mergeAccountConfig(config, defaultAccountId))) {
    return defaultAccountId;
  }

  return listConfiguredAccountIds(config)[0] ?? null;
}

function resolveDomain(domain) {
  const normalizedDomain = trimString(domain) ?? "feishu";
  if (normalizedDomain === "lark") {
    return lark.Domain.Lark;
  }
  if (normalizedDomain === "feishu") {
    return lark.Domain.Feishu;
  }
  return normalizedDomain.replace(/\/+$/, "");
}

export function resolveAccountById(config, accountId) {
  const normalizedAccountId = trimString(accountId);
  if (!normalizedAccountId) {
    throw new Error("Feishu accountId is required");
  }

  const merged = mergeAccountConfig(config, normalizedAccountId);
  const appId = trimString(merged?.appId);
  const appSecret = trimString(merged?.appSecret);
  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${normalizedAccountId}"`);
  }

  return {
    accountId: normalizedAccountId,
    appId,
    appSecret,
    domain: resolveDomain(merged?.domain),
  };
}

export function resolveToolAccount(config, agentAccountId) {
  const accountId = resolveToolAccountId(config, agentAccountId);
  if (!accountId) {
    throw new Error("No configured Feishu account with appId/appSecret was found");
  }
  return resolveAccountById(config, accountId);
}

export function createBaseClient(account) {
  return new lark.Client({
    appId: account.appId,
    appSecret: account.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: account.domain,
  });
}

export function buildGatewayBaseUrl(pluginConfig, gatewayPort) {
  const configuredBaseUrl = trimString(pluginConfig?.gatewayBaseUrl);
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }
  if (typeof gatewayPort === "number" && Number.isFinite(gatewayPort) && gatewayPort > 0) {
    return `http://127.0.0.1:${gatewayPort}`;
  }
  return DEFAULT_GATEWAY_BASE_URL;
}

export function buildCallbackUrl(baseUrl) {
  return `${baseUrl}/plugins/${FEISHU_USER_KB_PLUGIN_ID}/auth/callback`;
}

export function buildAuthStartUrl(baseUrl, accountId) {
  const params = new URLSearchParams({ accountId });
  return `${baseUrl}/plugins/${FEISHU_USER_KB_PLUGIN_ID}/auth/start?${params.toString()}`;
}

export function buildAuthorizeUrl({ appId, redirectUri, state }) {
  const params = new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    state,
  });
  return `${FEISHU_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}
