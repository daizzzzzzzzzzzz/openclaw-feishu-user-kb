export const FEISHU_DOCX_AI_FORMAT_PROFILE = "feishu_docx_ai_v1";

const HIGH_RISK_PATTERN_IDS = new Set([
  "frontmatter",
  "markdown_table",
  "raw_html",
  "diagram_fence",
  "footnote",
]);

const SUPPORTED_WITH_CAVEATS_PATTERN_IDS = new Set([
  "deep_heading",
  "task_list",
  "deep_nested_list",
  "image_link",
  "long_code_block",
]);

function normalizeMarkdown(markdown) {
  const input = typeof markdown === "string" ? markdown : String(markdown ?? "");
  const withoutBom = input.replace(/^\uFEFF/, "");
  const normalizedNewlines = withoutBom.replace(/\r\n?/g, "\n");
  const withoutTrailingSpaces = normalizedNewlines.replace(/[ \t]+\n/g, "\n");
  const compactBlankLines = withoutTrailingSpaces.replace(/\n{4,}/g, "\n\n\n");
  return compactBlankLines.trim();
}

function pushFinding(findings, patternId, severity, warning, recommendation) {
  findings.push({
    pattern_id: patternId,
    severity,
    warning,
    recommendation,
  });
}

function detectTables(markdown) {
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    if (!/\|/.test(current)) {
      continue;
    }
    if (/^\s*\|?[\s:-]+\|[\s|:-]*\|?\s*$/.test(next)) {
      return true;
    }
  }
  return false;
}

function detectDeepNestedList(markdown) {
  return /^(?: {4,}|\t{2,})(?:[-*+]|\d+\.)\s+/m.test(markdown);
}

function detectLongCodeBlock(markdown) {
  const fencedBlocks = markdown.match(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g) ?? [];
  return fencedBlocks.some((block) => block.length >= 1200);
}

function stripFencedBlocks(markdown) {
  return markdown.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, "\n");
}

export function analyzeMarkdownForFeishuDocx(markdown) {
  const findings = [];
  const text = typeof markdown === "string" ? markdown : String(markdown ?? "");
  const contentWithoutFences = stripFencedBlocks(text);

  if (/^---\n[\s\S]{0,4000}?\n---(?:\n|$)/.test(contentWithoutFences)) {
    pushFinding(
      findings,
      "frontmatter",
      "high",
      "YAML frontmatter is not a native Feishu docx concept and may be dropped during conversion.",
      "Move metadata into a visible \"## Metadata\" or \"## Quick Facts\" section near the top of the page.",
    );
  }

  if (detectTables(contentWithoutFences)) {
    pushFinding(
      findings,
      "markdown_table",
      "high",
      "Markdown tables often lose structure or readability after conversion to Feishu docx blocks.",
      "Use short bullet lists for small comparisons, or move tabular data into Bitable/Sheet.",
    );
  }

  if (/<[A-Za-z][^>\n]*>/.test(contentWithoutFences)) {
    pushFinding(
      findings,
      "raw_html",
      "high",
      "Raw HTML is not a stable authoring format for Feishu knowledge pages.",
      "Replace HTML with plain Markdown paragraphs, lists, or code fences before writing.",
    );
  }

  if (/^(`{3,}|~{3,})(mermaid|plantuml|graphviz|katex|latex)\s*$/im.test(text) || /^\$\$[\s\S]*?\$\$/m.test(text)) {
    pushFinding(
      findings,
      "diagram_fence",
      "high",
      "Diagram or math fences are unlikely to render as intended in a Feishu docx page.",
      "Convert diagrams to images/files, and rewrite formulas as plain text or short code snippets.",
    );
  }

  if (/\[\^[^\]]+\]/.test(contentWithoutFences) || /^\[\^[^\]]+\]:/m.test(contentWithoutFences)) {
    pushFinding(
      findings,
      "footnote",
      "high",
      "Markdown footnotes are not a dependable Feishu docx construct.",
      "Inline short references in the paragraph or add a final \"## References\" section.",
    );
  }

  if (/^#{4,}\s/m.test(contentWithoutFences)) {
    pushFinding(
      findings,
      "deep_heading",
      "medium",
      "Heading levels deeper than H3 are harder to keep readable in Feishu knowledge pages.",
      "Prefer H2 and H3 only, and flatten overly deep sections into bullets.",
    );
  }

  if (/^\s*[-*]\s+\[[ xX]\]\s+/m.test(contentWithoutFences)) {
    pushFinding(
      findings,
      "task_list",
      "medium",
      "Task list checkboxes may not preserve their interactive state after conversion.",
      "Use bullets with explicit status labels such as \"TODO:\", \"Doing:\", or \"Done:\".",
    );
  }

  if (detectDeepNestedList(contentWithoutFences)) {
    pushFinding(
      findings,
      "deep_nested_list",
      "medium",
      "Deeply nested lists are harder to read and more likely to flatten during conversion.",
      "Keep list nesting to two levels or less and split complex trees into separate sections.",
    );
  }

  if (/!\[[^\]]*\]\([^)]+\)/.test(contentWithoutFences)) {
    pushFinding(
      findings,
      "image_link",
      "medium",
      "Markdown image links are less predictable than native Feishu attachments or uploaded images.",
      "Store the image as a file/attachment and mention it in a short reference line in the docx page.",
    );
  }

  if (detectLongCodeBlock(text)) {
    pushFinding(
      findings,
      "long_code_block",
      "medium",
      "Very large code fences reduce readability and increase conversion fragility.",
      "Keep only the key excerpt in the page and move the full source into a file attachment or repository link.",
    );
  }

  const detectedPatterns = findings.map((finding) => finding.pattern_id);
  const hasHighRiskPattern = detectedPatterns.some((patternId) => HIGH_RISK_PATTERN_IDS.has(patternId));
  const hasCaveatPattern = detectedPatterns.some((patternId) => SUPPORTED_WITH_CAVEATS_PATTERN_IDS.has(patternId));

  let level = "ideal";
  if (hasHighRiskPattern) {
    level = "high_risk";
  } else if (hasCaveatPattern) {
    level = "supported_with_caveats";
  }

  const recommendations = [
    "Use the page title field for the main title, then start content with a short summary section.",
    "Prefer H2/H3 sections, short paragraphs, bullets, numbered steps, and brief code fences.",
    "Keep stable metadata near the top with labels such as Scope, Owner, Updated, and Tags.",
    "Move dense tables to Bitable/Sheet and move raw source files such as .md or .pdf into attachments.",
  ];

  for (const finding of findings) {
    if (!recommendations.includes(finding.recommendation)) {
      recommendations.push(finding.recommendation);
    }
  }

  return {
    format_profile: FEISHU_DOCX_AI_FORMAT_PROFILE,
    compatibility: {
      level,
      safe_for_docx: level !== "high_risk",
      detected_patterns: detectedPatterns,
    },
    warnings: findings.map((finding) => finding.warning),
    recommendations,
  };
}

export function prepareMarkdownForFeishuDocx(markdown) {
  const normalizedMarkdown = normalizeMarkdown(markdown);
  const analysis = analyzeMarkdownForFeishuDocx(normalizedMarkdown);
  return {
    ...analysis,
    normalized_markdown: normalizedMarkdown,
    normalized_content_changed: normalizedMarkdown !== (typeof markdown === "string" ? markdown : String(markdown ?? "")),
  };
}

export const FEISHU_DOCX_AI_FORMAT_GUIDANCE = [
  "Follow the feishu_docx_ai_v1 page profile when writing Feishu docx pages.",
  "Use create_page title for the page title. In page content, start with a short summary, then H2/H3 sections.",
  "Keep metadata visible near the top using bullets such as Scope, Owner, Updated, Tags, and Keywords.",
  "Prefer short paragraphs, bullet lists, numbered procedures, concise quotes, and short code fences.",
  "Avoid Markdown tables, raw HTML, Mermaid or math fences, footnotes, heading levels deeper than H3, and deeply nested lists.",
  "If information is highly tabular, store it in Bitable/Sheet. If exact source fidelity matters, attach the original file.",
].join("\n");
