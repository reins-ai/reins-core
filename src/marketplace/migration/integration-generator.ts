interface InstallSpec {
  kind: "brew" | "node" | "go" | "uv";
  packageName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeInstallKind(value: string): InstallSpec["kind"] | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === "brew" || normalized === "homebrew") {
    return "brew";
  }

  if (normalized === "node" || normalized === "npm") {
    return "node";
  }

  if (normalized === "go" || normalized === "golang") {
    return "go";
  }

  if (normalized === "uv" || normalized === "python" || normalized === "pip") {
    return "uv";
  }

  return null;
}

function findFirstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function normalizeInstallSpec(value: unknown): InstallSpec | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawKind = findFirstString(value, ["kind", "type", "manager"]);
  if (!rawKind) {
    return null;
  }

  const kind = normalizeInstallKind(rawKind);
  if (!kind) {
    return null;
  }

  const packageName = findFirstString(value, ["package", "packageName", "name", "module", "formula"]);
  if (!packageName) {
    return null;
  }

  return {
    kind,
    packageName,
  };
}

function collectInstallSpecs(openclawMetadata: Record<string, unknown>): InstallSpec[] {
  const specs: InstallSpec[] = [];
  const candidates = [openclawMetadata.install, openclawMetadata.installs];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const normalized = normalizeInstallSpec(entry);
        if (normalized) {
          specs.push(normalized);
        }
      }
      continue;
    }

    const normalized = normalizeInstallSpec(candidate);
    if (normalized) {
      specs.push(normalized);
    }
  }

  const uniqueByCommand = new Map<string, InstallSpec>();
  for (const spec of specs) {
    const key = `${spec.kind}:${spec.packageName}`;
    if (!uniqueByCommand.has(key)) {
      uniqueByCommand.set(key, spec);
    }
  }

  return Array.from(uniqueByCommand.values());
}

function installCommand(spec: InstallSpec): string {
  if (spec.kind === "brew") {
    return `brew install ${spec.packageName}`;
  }

  if (spec.kind === "node") {
    return `npm install ${spec.packageName}`;
  }

  if (spec.kind === "go") {
    return `go install ${spec.packageName}`;
  }

  return `uv pip install ${spec.packageName}`;
}

function serializeConfigValue(value: unknown, depth: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    const lines: string[] = [];
    for (const entry of value) {
      const indent = "  ".repeat(depth);
      if (isRecord(entry) || Array.isArray(entry)) {
        lines.push(`${indent}-`);
        lines.push(serializeConfigValue(entry, depth + 1));
      } else {
        lines.push(`${indent}- ${String(entry)}`);
      }
    }
    return lines.join("\n");
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }

    const lines: string[] = [];
    for (const [key, entry] of entries) {
      const indent = "  ".repeat(depth);
      if (isRecord(entry) || Array.isArray(entry)) {
        lines.push(`${indent}${key}:`);
        lines.push(serializeConfigValue(entry, depth + 1));
      } else {
        lines.push(`${indent}${key}: ${String(entry)}`);
      }
    }
    return lines.join("\n");
  }

  return `${"  ".repeat(depth)}${String(value)}`;
}

export function generateIntegrationMd(openclawMetadata: Record<string, unknown> | null): string | null {
  if (!openclawMetadata) {
    return null;
  }

  const requirements = isRecord(openclawMetadata.requires) ? openclawMetadata.requires : null;
  const envVars = toStringArray(requirements?.env);
  const requiredTools = toStringArray(requirements?.bins);
  const config = isRecord(openclawMetadata.config) ? openclawMetadata.config : null;
  const installSpecs = collectInstallSpecs(openclawMetadata);

  const hasConfig = Boolean(config && Object.keys(config).length > 0);
  const hasRequirements = envVars.length > 0 || requiredTools.length > 0 || installSpecs.length > 0;

  if (!hasConfig && !hasRequirements) {
    return null;
  }

  const lines: string[] = [
    "# INTEGRATION.md",
    "",
    "## Purpose",
    "",
    "Provide setup details required to run this migrated OpenClaw skill in Reins.",
    "",
    "## Setup / Installation requirements",
    "",
  ];

  if (installSpecs.length > 0) {
    lines.push("Run the following commands before using this skill:");
    lines.push("");
    for (const spec of installSpecs) {
      lines.push(`- \`${installCommand(spec)}\``);
    }
    lines.push("");
  } else {
    lines.push("No package-manager installation commands were provided.");
    lines.push("");
  }

  if (requiredTools.length > 0) {
    lines.push("Required CLI tools:");
    lines.push("");
    for (const tool of requiredTools) {
      lines.push(`- \`${tool}\``);
    }
    lines.push("");
  }

  lines.push("## Environment variables");
  lines.push("");
  if (envVars.length > 0) {
    for (const variable of envVars) {
      lines.push(`- \`${variable}\``);
    }
  } else {
    lines.push("No environment variables are required.");
  }
  lines.push("");

  lines.push("## Configuration");
  lines.push("");
  if (hasConfig && config) {
    lines.push("```yaml");
    lines.push(serializeConfigValue(config, 0));
    lines.push("```");
  } else {
    lines.push("No additional configuration is required.");
  }

  return lines.join("\n");
}
