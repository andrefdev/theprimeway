import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@shared/hooks/useTranslation';
import { toolRegistry } from '../tools/registry';
import type { ToolResult } from '../tools/types';

export function useExecuteTool() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('features.ai');
  const [busyToolCallId, setBusyToolCallId] = useState<string | null>(null);

  const execute = useCallback(
    async (toolCallId: string, toolName: string, args: unknown): Promise<ToolResult> => {
      const handler = toolRegistry[toolName];
      if (!handler) return { success: false, error: `Unknown tool: ${toolName}` };
      setBusyToolCallId(toolCallId);
      try {
        return await handler.execute(args as never, { queryClient, t });
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed',
        };
      } finally {
        setBusyToolCallId(null);
      }
    },
    [queryClient, t]
  );

  return { execute, busyToolCallId };
}
