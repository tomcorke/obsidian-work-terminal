import { parse as parseYaml } from "yaml";

export function extractYamlFrontmatterString(content: string, key: string): string | null {
  const frontmatter = extractFrontmatterBlock(content);
  if (frontmatter === null) {
    return null;
  }

  try {
    return extractParsedStringValue(parseYaml(frontmatter), key);
  } catch {
    const isolatedLine = extractFrontmatterLine(frontmatter, key);
    if (!isolatedLine) {
      return null;
    }

    try {
      return extractParsedStringValue(parseYaml(isolatedLine), key);
    } catch {
      return null;
    }
  }
}

function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m);
  return match ? match[1] : null;
}

function extractParsedStringValue(parsed: unknown, key: string): string | null {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return null;
  }

  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function extractFrontmatterLine(frontmatter: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(
    new RegExp(`^${escapedKey}[ \\t]*:[ \\t]*[^\\r\\n]*$`, "m"),
  );
  return match?.[0] ?? null;
}
