import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

import { err, ok, type Result } from "../../result";
import { SystemToolExecutionError } from "./types";

export function validatePath(
  targetPath: string,
  sandboxRoot: string,
): Result<string, SystemToolExecutionError> {
  const normalizedTargetInput = normalizeInputPath(targetPath);
  if (normalizedTargetInput.length === 0) {
    return err(
      SystemToolExecutionError.permissionDenied("Path validation failed", {
        attemptedPath: targetPath,
        sandboxRoot,
        reason: "empty_path",
      }),
    );
  }

  const normalizedRootInput = normalizeInputPath(sandboxRoot);
  if (normalizedRootInput.length === 0) {
    return err(
      SystemToolExecutionError.permissionDenied("Path validation failed", {
        attemptedPath: targetPath,
        sandboxRoot,
        reason: "invalid_sandbox_root",
      }),
    );
  }

  const resolvedRoot = normalize(resolve(normalizedRootInput));
  const resolvedTarget = normalize(
    isAbsolute(normalizedTargetInput)
      ? resolve(normalizedTargetInput)
      : resolve(resolvedRoot, normalizedTargetInput),
  );

  if (!isWithinRoot(resolvedTarget, resolvedRoot)) {
    return err(
      SystemToolExecutionError.permissionDenied("Path escapes sandbox root", {
        attemptedPath: targetPath,
        sandboxRoot: resolvedRoot,
        reason: "path_outside_sandbox",
      }),
    );
  }

  const realRoot = toRealPathSafe(resolvedRoot);
  const canonicalTarget = resolveWithExistingAncestorRealPath(resolvedTarget);

  if (realRoot !== null && !isWithinRoot(canonicalTarget, realRoot)) {
    return err(
      SystemToolExecutionError.permissionDenied("Path escapes sandbox root", {
        attemptedPath: targetPath,
        sandboxRoot: realRoot,
        reason: "resolved_path_outside_sandbox",
      }),
    );
  }

  return ok(canonicalTarget);
}

export function isSafeRelativePath(path: string): boolean {
  const normalizedInput = normalizeInputPath(path);
  if (normalizedInput.length === 0) {
    return false;
  }

  if (isAbsolute(normalizedInput) || isWindowsAbsolutePath(normalizedInput)) {
    return false;
  }

  const segments = normalizedInput.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return !segments.includes("..");
}

function normalizeInputPath(path: string): string {
  return path.trim();
}

function isWithinRoot(target: string, root: string): boolean {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot.length === 0) {
    return true;
  }

  return !pathFromRoot.startsWith("..") && pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`);
}

function resolveWithExistingAncestorRealPath(targetPath: string): string {
  let current = targetPath;
  const suffix: string[] = [];

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return targetPath;
    }

    suffix.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }

  const resolvedExisting = toRealPathSafe(current);
  if (resolvedExisting === null) {
    return targetPath;
  }

  return suffix.reduce((accumulator, segment) => resolve(accumulator, segment), resolvedExisting);
}

function toRealPathSafe(path: string): string | null {
  try {
    return normalize(realpathSync(path));
  } catch {
    return null;
  }
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);
}
