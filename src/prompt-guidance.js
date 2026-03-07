import { FEISHU_DOCX_AI_FORMAT_GUIDANCE } from "./format-profile.js";

export const FEISHU_USER_KB_PROMPT_GUIDANCE = [
  "When the task involves Feishu knowledge bases or Feishu cloud docs, use only the feishu_user_kb tool.",
  "Do not use feishu_wiki or feishu_doc.",
  "If feishu_user_kb returns status auth_required or reauthorization_required, ask the user to open auth_url in the local browser and complete Feishu authorization before continuing.",
  "When the task is primarily structured rows, columns, statuses, or inventories, prefer the bitable actions in feishu_user_kb instead of forcing the content into a docx page.",
  FEISHU_DOCX_AI_FORMAT_GUIDANCE,
].join("\n");
