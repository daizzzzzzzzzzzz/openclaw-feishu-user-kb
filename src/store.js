import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_RECORD = Object.freeze({
  version: 1,
  ownerOpenId: null,
  ownerUserId: null,
  name: null,
  email: null,
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  grantedAt: null,
  updatedAt: null,
  lastError: null,
});

const accountLocks = new Map();

function toNullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getCredentialDir(credentialDir) {
  return credentialDir ?? path.join(homedir(), ".openclaw", "credentials");
}

export function getCredentialPath(accountId, credentialDir) {
  return path.join(getCredentialDir(credentialDir), `feishu-${accountId}-user-auth.json`);
}

export function normalizeCredentialRecord(rawValue) {
  const rawRecord = rawValue && typeof rawValue === "object" ? rawValue : {};
  return {
    version: 1,
    ownerOpenId: toNullableString(rawRecord.ownerOpenId),
    ownerUserId: toNullableString(rawRecord.ownerUserId),
    name: toNullableString(rawRecord.name),
    email: toNullableString(rawRecord.email),
    accessToken: toNullableString(rawRecord.accessToken),
    refreshToken: toNullableString(rawRecord.refreshToken),
    accessTokenExpiresAt: toNullableString(rawRecord.accessTokenExpiresAt),
    refreshTokenExpiresAt: toNullableString(rawRecord.refreshTokenExpiresAt),
    grantedAt: toNullableString(rawRecord.grantedAt),
    updatedAt: toNullableString(rawRecord.updatedAt),
    lastError: toNullableString(rawRecord.lastError),
  };
}

export async function readCredentialRecord(accountId, credentialDir) {
  const filePath = getCredentialPath(accountId, credentialDir);
  if (!existsSync(filePath)) {
    return null;
  }

  const fileContents = await readFile(filePath, "utf8");
  return normalizeCredentialRecord(JSON.parse(fileContents));
}

export async function writeCredentialRecord(accountId, credentialDir, record) {
  const directoryPath = getCredentialDir(credentialDir);
  await mkdir(directoryPath, { recursive: true });

  const filePath = getCredentialPath(accountId, credentialDir);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const normalizedRecord = {
    ...DEFAULT_RECORD,
    ...normalizeCredentialRecord(record),
  };

  await writeFile(tempPath, `${JSON.stringify(normalizedRecord, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    if (error && typeof error === "object" && (error.code === "EEXIST" || error.code === "EPERM")) {
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    } else {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export function serializeError(error) {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown error";
  }
  return String(error);
}

export function withAccountLock(accountId, fn) {
  const previous = accountLocks.get(accountId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const queued = run.catch(() => {});
  const cleanup = queued.finally(() => {
    if (accountLocks.get(accountId) === cleanup) {
      accountLocks.delete(accountId);
    }
  });
  accountLocks.set(accountId, cleanup);
  return run;
}
