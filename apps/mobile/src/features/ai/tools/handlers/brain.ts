import { toast } from '@shared/lib/toast';
import { brainApi } from '@/features/brain/api';
import type { ToolHandler } from '../types';

export interface SaveBrainIdeaArgs {
  content: string;
}

export const saveBrainIdeaHandler: ToolHandler<SaveBrainIdeaArgs> = {
  name: 'saveBrainIdea',
  execute: async (args, { queryClient, t }) => {
    const entry = await brainApi.create(args.content);
    queryClient.invalidateQueries({ queryKey: ['brain'] });
    toast.success(t('brainIdeaSaved', { defaultValue: 'Idea saved to brain' }));
    return { success: true, entry: { id: entry.id, status: entry.status } };
  },
};
