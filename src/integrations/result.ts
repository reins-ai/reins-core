export type IntegrationResultKind = "list" | "detail" | "error";

export interface CompactResult<TData = unknown> {
  kind: IntegrationResultKind;
  summary: string;
  data?: TData;
  count?: number;
  error?: {
    code?: string;
    message: string;
  };
}

export interface RichResult<TData = unknown> {
  kind: IntegrationResultKind;
  title: string;
  message: string;
  data?: TData;
  metadata?: Record<string, unknown>;
}

export interface IntegrationResult<TModel = unknown, TUser = unknown> {
  forModel: CompactResult<TModel>;
  forUser: RichResult<TUser>;
}

export interface ListResultFormatterOptions<TRaw, TModel, TUser = TRaw> {
  entityName: string;
  items: readonly TRaw[];
  toModel: (item: TRaw, index: number) => TModel;
  toUser?: (item: TRaw, index: number) => TUser;
  title?: string;
  emptyMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface DetailResultFormatterOptions<TRaw, TModel, TUser = TRaw> {
  entityName: string;
  item: TRaw;
  toModel: (item: TRaw) => TModel;
  toUser?: (item: TRaw) => TUser;
  title?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorResultFormatterOptions {
  code?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  retryable?: boolean;
}

const defaultUserMapper = <TRaw>(item: TRaw): TRaw => item;

export function formatListResult<TRaw, TModel, TUser = TRaw>(
  options: ListResultFormatterOptions<TRaw, TModel, TUser>,
): IntegrationResult<{ items: TModel[] }, { items: TUser[] }> {
  const modelItems = options.items.map((item, index) => options.toModel(item, index));
  const userMapper = options.toUser ?? defaultUserMapper<TRaw>;
  const userItems = options.items.map((item, index) => userMapper(item, index) as unknown as TUser);
  const count = options.items.length;
  const label = options.entityName.trim() || "items";

  return {
    forModel: {
      kind: "list",
      summary: count === 0 ? `No ${label}.` : `${count} ${label}`,
      count,
      data: {
        items: modelItems,
      },
    },
    forUser: {
      kind: "list",
      title: options.title ?? `${capitalize(label)} Results`,
      message: count === 0 ? options.emptyMessage ?? `No ${label} found.` : `${count} ${label} found.`,
      data: {
        items: userItems,
      },
      metadata: options.metadata,
    },
  };
}

export function formatDetailResult<TRaw, TModel, TUser = TRaw>(
  options: DetailResultFormatterOptions<TRaw, TModel, TUser>,
): IntegrationResult<TModel, TUser> {
  const userMapper = options.toUser ?? defaultUserMapper<TRaw>;
  const label = options.entityName.trim() || "item";

  return {
    forModel: {
      kind: "detail",
      summary: `${label} details`,
      data: options.toModel(options.item),
    },
    forUser: {
      kind: "detail",
      title: options.title ?? `${capitalize(label)} Details`,
      message: options.message ?? `Showing ${label} details.`,
      data: userMapper(options.item) as unknown as TUser,
      metadata: options.metadata,
    },
  };
}

export function formatErrorResult(
  error: unknown,
  options: ErrorResultFormatterOptions = {},
): IntegrationResult<null, null> {
  const message = toErrorMessage(error);

  return {
    forModel: {
      kind: "error",
      summary: message,
      error: {
        code: options.code,
        message,
      },
    },
    forUser: {
      kind: "error",
      title: options.title ?? "Integration Error",
      message,
      data: null,
      metadata: {
        ...options.metadata,
        retryable: options.retryable ?? false,
      },
    },
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Integration operation failed.";
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
