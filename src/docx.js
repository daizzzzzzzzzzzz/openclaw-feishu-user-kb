import * as lark from "@larksuiteoapi/node-sdk";
import { prepareMarkdownForFeishuDocx } from "./format-profile.js";

const MAX_CONVERT_RETRY_DEPTH = 8;

function assertSuccess(response, fallbackMessage) {
  if (response?.code !== 0) {
    throw new Error(response?.msg || fallbackMessage);
  }
}

function withUser(accessToken) {
  return lark.withUserAccessToken(accessToken);
}

function cleanBlocksForDescendant(blocks) {
  return blocks.map((block) => {
    const { parent_id: _parentId, ...cleanBlock } = block ?? {};
    if (cleanBlock.block_type === 32 && typeof cleanBlock.children === "string") {
      cleanBlock.children = [cleanBlock.children];
    }
    if (cleanBlock.block_type === 31 && cleanBlock.table) {
      const property = cleanBlock.table.property ?? {};
      cleanBlock.table = {
        property: {
          row_size: property.row_size,
          column_size: property.column_size,
          ...(Array.isArray(property.column_width) ? { column_width: property.column_width } : {}),
        },
      };
    }
    return cleanBlock;
  });
}

function sortBlocksByFirstLevel(blocks, firstLevelBlockIds) {
  if (!Array.isArray(firstLevelBlockIds) || firstLevelBlockIds.length === 0) {
    return blocks;
  }
  const ordered = [];
  const remaining = [];
  const firstLevelSet = new Set(firstLevelBlockIds);
  for (const blockId of firstLevelBlockIds) {
    const block = blocks.find((entry) => entry?.block_id === blockId);
    if (block) {
      ordered.push(block);
    }
  }
  for (const block of blocks) {
    if (!firstLevelSet.has(block?.block_id)) {
      remaining.push(block);
    }
  }
  return [...ordered, ...remaining];
}

async function convertMarkdown(client, accessToken, markdown) {
  const convertResponse = await client.docx.document.convert(
    {
      data: {
        content_type: "markdown",
        content: markdown,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(convertResponse, "Failed to convert markdown for Feishu docx");
  return {
    blocks: convertResponse?.data?.blocks ?? [],
    firstLevelBlockIds: convertResponse?.data?.first_level_block_ids ?? [],
  };
}

function splitMarkdownByHeadings(markdown) {
  const lines = markdown.split("\n");
  const chunks = [];
  let current = [];
  let inFencedBlock = false;

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
    }
    if (!inFencedBlock && /^#{1,2}\s/.test(line) && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks.length > 0 ? chunks : [markdown];
}

function splitMarkdownBySize(markdown, maxChars) {
  if (markdown.length <= maxChars) {
    return [markdown];
  }

  const lines = markdown.split("\n");
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let inFencedBlock = false;

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
    }

    const lineLength = line.length + 1;
    const wouldExceed = currentLength + lineLength > maxChars;
    if (current.length > 0 && wouldExceed && !inFencedBlock) {
      chunks.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }

    current.push(line);
    currentLength += lineLength;
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  if (chunks.length > 1) {
    return chunks;
  }

  const midpoint = Math.floor(lines.length / 2);
  if (midpoint <= 0 || midpoint >= lines.length) {
    return [markdown];
  }
  return [lines.slice(0, midpoint).join("\n"), lines.slice(midpoint).join("\n")];
}

async function convertMarkdownWithFallback(client, accessToken, markdown, depth = 0) {
  try {
    return await convertMarkdown(client, accessToken, markdown);
  } catch (error) {
    if (depth >= MAX_CONVERT_RETRY_DEPTH || markdown.length < 2) {
      throw error;
    }

    const splitTarget = Math.max(256, Math.floor(markdown.length / 2));
    const chunks = splitMarkdownBySize(markdown, splitTarget);
    if (chunks.length <= 1) {
      throw error;
    }

    const blocks = [];
    const firstLevelBlockIds = [];
    for (const chunk of chunks) {
      const converted = await convertMarkdownWithFallback(client, accessToken, chunk, depth + 1);
      blocks.push(...converted.blocks);
      firstLevelBlockIds.push(...converted.firstLevelBlockIds);
    }
    return { blocks, firstLevelBlockIds };
  }
}

async function chunkedConvertMarkdown(client, accessToken, markdown) {
  const chunks = splitMarkdownByHeadings(markdown);
  const allBlocks = [];
  const allFirstLevelBlockIds = [];
  for (const chunk of chunks) {
    const converted = await convertMarkdownWithFallback(client, accessToken, chunk);
    allBlocks.push(...sortBlocksByFirstLevel(converted.blocks, converted.firstLevelBlockIds));
    allFirstLevelBlockIds.push(...converted.firstLevelBlockIds);
  }
  return {
    blocks: cleanBlocksForDescendant(allBlocks),
    firstLevelBlockIds: allFirstLevelBlockIds,
  };
}

async function insertConvertedBlocks(client, accessToken, docToken, converted) {
  const blocks = converted?.blocks ?? [];
  const firstLevelBlockIds = converted?.firstLevelBlockIds ?? [];
  if (blocks.length === 0) {
    throw new Error("Content is empty or the Markdown could not be represented as Feishu blocks");
  }

  const insertResponse = await client.docx.documentBlockDescendant.create(
    {
      path: {
        document_id: docToken,
        block_id: docToken,
      },
      data: {
        children_id: firstLevelBlockIds,
        descendants: blocks,
        index: -1,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(insertResponse, "Failed to append Feishu document blocks");

  return {
    blocks_added: blocks.length,
    block_ids: (insertResponse?.data?.children ?? []).map((block) => block?.block_id).filter(Boolean),
  };
}

export async function resolveDocTokenFromNode(client, accessToken, nodeToken) {
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
  if (node?.obj_type !== "docx") {
    throw new Error(`Wiki node "${nodeToken}" is "${node?.obj_type}" and not a docx page`);
  }

  return {
    docToken: node.obj_token,
    node,
  };
}

export async function readDocument(client, accessToken, docToken) {
  const [rawContentResponse, documentResponse] = await Promise.all([
    client.docx.document.rawContent(
      {
        path: {
          document_id: docToken,
        },
      },
      withUser(accessToken),
    ),
    client.docx.document.get(
      {
        path: {
          document_id: docToken,
        },
      },
      withUser(accessToken),
    ),
  ]);

  assertSuccess(rawContentResponse, "Failed to read Feishu document content");
  assertSuccess(documentResponse, "Failed to read Feishu document metadata");

  return {
    document_id: docToken,
    title: documentResponse?.data?.document?.title ?? null,
    revision_id: documentResponse?.data?.document?.revision_id ?? null,
    content: rawContentResponse?.data?.content ?? "",
  };
}

export async function clearDocument(client, accessToken, docToken) {
  const blocksResponse = await client.docx.documentBlock.list(
    {
      path: {
        document_id: docToken,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(blocksResponse, "Failed to list Feishu document blocks");

  const topLevelChildren =
    blocksResponse?.data?.items?.filter((block) => block?.parent_id === docToken && block?.block_type !== 1) ??
    [];
  if (topLevelChildren.length === 0) {
    return 0;
  }

  const deleteResponse = await client.docx.documentBlockChildren.batchDelete(
    {
      path: {
        document_id: docToken,
        block_id: docToken,
      },
      data: {
        start_index: 0,
        end_index: topLevelChildren.length,
      },
    },
    withUser(accessToken),
  );
  assertSuccess(deleteResponse, "Failed to clear Feishu document content");
  return topLevelChildren.length;
}

export async function appendMarkdownToDocument(client, accessToken, docToken, markdown) {
  const prepared = prepareMarkdownForFeishuDocx(markdown);
  const converted = await chunkedConvertMarkdown(client, accessToken, prepared.normalized_markdown);
  const appended = await insertConvertedBlocks(client, accessToken, docToken, converted);
  return {
    success: true,
    ...appended,
    format_profile: prepared.format_profile,
    compatibility: prepared.compatibility,
    warnings: prepared.warnings,
    recommendations: prepared.recommendations,
    normalized_content_changed: prepared.normalized_content_changed,
  };
}

export async function writeMarkdownToDocument(client, accessToken, docToken, markdown) {
  const prepared = prepareMarkdownForFeishuDocx(markdown);
  const converted = await chunkedConvertMarkdown(client, accessToken, prepared.normalized_markdown);
  const blocksDeleted = await clearDocument(client, accessToken, docToken);
  const appended = await insertConvertedBlocks(client, accessToken, docToken, converted);
  return {
    success: true,
    blocks_deleted: blocksDeleted,
    blocks_added: appended.blocks_added,
    block_ids: appended.block_ids,
    format_profile: prepared.format_profile,
    compatibility: prepared.compatibility,
    warnings: prepared.warnings,
    recommendations: prepared.recommendations,
    normalized_content_changed: prepared.normalized_content_changed,
  };
}
