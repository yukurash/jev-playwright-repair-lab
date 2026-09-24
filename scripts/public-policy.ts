export function inspectPublicText(path: string, text: string): string[] {
  const errors: string[] = [];
  if (/(^|\/)(?:article|articles|private|local-config|runs|workspaces)(?:\/|$)|\.env(?:\.|$)|\.jsonl$/.test(path.replaceAll("\\", "/"))) {
    errors.push(`${path}: private-only file path`);
  }
  const checks: [RegExp, string][] = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
    [/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{24,}/, "credential-like value"],
    [/(?:TYPESAFE_API_KEY|AZURE_OPENAI_API_KEY)\s*[:=]\s*["']?[A-Za-z0-9_-]{24,}/, "API key assignment"],
    [/C:[\\/]Users[\\/](?!example\b|YOUR_USER\b)[^\\/\s"'<>]+/i, "personal local path"],
    [/https:\/\/(?!YOUR[-_]RESOURCE\.|example\.|<)[a-z0-9-]+\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)/i, "actual Azure endpoint"],
    [/^published:\s*(?:true|false)\s*$/m, "Zenn manuscript frontmatter"],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) errors.push(`${path}: ${label}`);
  }
  return errors;
}

export function inspectSnapshot(html: string): string[] {
  const errors: string[] = [];
  if (/<(?:script|iframe|object|embed|base|link)\b/i.test(html)) errors.push("active or external snapshot content");
  if (/\son[a-z]+\s*=|javascript:|data:text\/html/i.test(html)) errors.push("executable snapshot content");
  if (/(?:src|href|action)\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(html)) errors.push("external snapshot URL");
  return errors;
}
