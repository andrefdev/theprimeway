import type { QueryClient } from '@tanstack/react-query';

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

export interface ToolContext {
  queryClient: QueryClient;
  t: TranslateFn;
}

export type ToolResult = Record<string, unknown>;

export interface ToolHandler<TArgs = unknown> {
  name: string;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
}
