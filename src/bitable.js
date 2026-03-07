import * as lark from "@larksuiteoapi/node-sdk";

const FIELD_TYPE_NAMES = {
  1: "Text",
  2: "Number",
  3: "SingleSelect",
  4: "MultiSelect",
  5: "DateTime",
  7: "Checkbox",
  11: "User",
  13: "Phone",
  15: "URL",
  17: "Attachment",
  18: "SingleLink",
  19: "Lookup",
  20: "Formula",
  21: "DuplexLink",
  22: "Location",
  23: "GroupChat",
  1001: "CreatedTime",
  1002: "ModifiedTime",
  1003: "CreatedUser",
  1004: "ModifiedUser",
  1005: "AutoNumber",
};

function assertSuccess(response, fallbackMessage) {
  if (response?.code !== 0) {
    throw new Error(response?.msg || fallbackMessage);
  }
}

function withUser(accessToken) {
  return lark.withUserAccessToken(accessToken);
}

function normalizeFieldType(type) {
  return FIELD_TYPE_NAMES[type] ?? `type_${String(type ?? "unknown")}`;
}

function normalizeRecord(record) {
  return {
    record_id: record?.record_id ?? null,
    fields: record?.fields ?? {},
    created_time: record?.created_time ?? null,
    last_modified_time: record?.last_modified_time ?? null,
    created_by: record?.created_by ?? null,
    last_modified_by: record?.last_modified_by ?? null,
    record_url: record?.record_url ?? null,
    shared_url: record?.shared_url ?? null,
  };
}

function normalizeField(field) {
  return {
    field_id: field?.field_id ?? null,
    field_name: field?.field_name ?? null,
    type: field?.type ?? null,
    type_name: normalizeFieldType(field?.type),
    is_primary: field?.is_primary ?? null,
    is_hidden: field?.is_hidden ?? null,
    ui_type: field?.ui_type ?? null,
    property: field?.property ?? null,
    description: field?.description ?? null,
  };
}

function normalizeTable(table) {
  return {
    table_id: table?.table_id ?? null,
    name: table?.name ?? null,
    revision: table?.revision ?? null,
    default_view_id: table?.default_view_id ?? null,
  };
}

function normalizeApp(app) {
  return {
    app_token: app?.app_token ?? null,
    name: app?.name ?? null,
    revision: app?.revision ?? null,
    is_advanced: app?.is_advanced ?? null,
    time_zone: app?.time_zone ?? null,
    url: app?.url ?? null,
  };
}

export async function resolveBitableAppTokenFromNode(client, accessToken, nodeToken) {
  const response = await client.wiki.space.getNode(
    {
      params: {
        token: nodeToken,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to resolve wiki node");

  const node = response?.data?.node;
  if (!node?.obj_token) {
    throw new Error(`Wiki node "${nodeToken}" did not return an obj_token`);
  }
  if (node?.obj_type !== "bitable") {
    throw new Error(`Wiki node "${nodeToken}" is "${node?.obj_type}" and not a bitable`);
  }

  return {
    appToken: node.obj_token,
    node,
  };
}

export async function getBitableApp(client, accessToken, appToken) {
  const response = await client.bitable.app.get(
    {
      path: {
        app_token: appToken,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to read Feishu bitable metadata");
  return {
    app: normalizeApp(response?.data?.app),
  };
}

export async function listBitableTables(client, accessToken, appToken) {
  const response = await client.bitable.appTable.list(
    {
      path: {
        app_token: appToken,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to list Feishu bitable tables");

  return {
    tables: (response?.data?.items ?? []).map(normalizeTable),
    total: response?.data?.total ?? response?.data?.items?.length ?? 0,
    has_more: response?.data?.has_more ?? false,
    page_token: response?.data?.page_token ?? null,
  };
}

export async function createBitableTable(client, accessToken, appToken, tableName, defaultViewName, tableFields) {
  const response = await client.bitable.appTable.create(
    {
      path: {
        app_token: appToken,
      },
      data: {
        table: {
          name: tableName,
          ...(defaultViewName ? { default_view_name: defaultViewName } : {}),
          ...(Array.isArray(tableFields) && tableFields.length > 0 ? { fields: tableFields } : {}),
        },
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to create Feishu bitable table");

  return {
    table: normalizeTable(response?.data?.table),
  };
}

export async function listBitableFields(client, accessToken, appToken, tableId) {
  const response = await client.bitable.appTableField.list(
    {
      path: {
        app_token: appToken,
        table_id: tableId,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to list Feishu bitable fields");

  return {
    fields: (response?.data?.items ?? []).map(normalizeField),
    total: response?.data?.total ?? response?.data?.items?.length ?? 0,
    has_more: response?.data?.has_more ?? false,
    page_token: response?.data?.page_token ?? null,
  };
}

export async function createBitableField(client, accessToken, appToken, tableId, fieldName, fieldType, property) {
  const response = await client.bitable.appTableField.create(
    {
      path: {
        app_token: appToken,
        table_id: tableId,
      },
      data: {
        field_name: fieldName,
        type: fieldType,
        ...(property ? { property } : {}),
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to create Feishu bitable field");

  return {
    field: normalizeField(response?.data?.field),
  };
}

export async function listBitableRecords(client, accessToken, appToken, tableId, pageSize, pageToken) {
  const response = await client.bitable.appTableRecord.list(
    {
      path: {
        app_token: appToken,
        table_id: tableId,
      },
      params: {
        ...(typeof pageSize === "number" ? { page_size: pageSize } : {}),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to list Feishu bitable records");

  return {
    records: (response?.data?.items ?? []).map(normalizeRecord),
    total: response?.data?.total ?? response?.data?.items?.length ?? 0,
    has_more: response?.data?.has_more ?? false,
    page_token: response?.data?.page_token ?? null,
  };
}

export async function getBitableRecord(client, accessToken, appToken, tableId, recordId) {
  const response = await client.bitable.appTableRecord.get(
    {
      path: {
        app_token: appToken,
        table_id: tableId,
        record_id: recordId,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to read Feishu bitable record");

  return {
    record: normalizeRecord(response?.data?.record),
  };
}

export async function createBitableRecord(client, accessToken, appToken, tableId, fields) {
  const response = await client.bitable.appTableRecord.create(
    {
      path: {
        app_token: appToken,
        table_id: tableId,
      },
      data: {
        fields,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to create Feishu bitable record");

  return {
    record: normalizeRecord(response?.data?.record),
  };
}

export async function updateBitableRecord(client, accessToken, appToken, tableId, recordId, fields) {
  const response = await client.bitable.appTableRecord.update(
    {
      path: {
        app_token: appToken,
        table_id: tableId,
        record_id: recordId,
      },
      data: {
        fields,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(response, "Failed to update Feishu bitable record");

  return {
    record: normalizeRecord(response?.data?.record),
  };
}
