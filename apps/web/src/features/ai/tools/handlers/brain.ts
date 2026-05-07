import { toast } from 'sonner'
import { brainApi } from '@/features/brain/api'
import { brainKeys } from '@/features/brain/queries'
import type { ToolHandler } from '../types'

export interface SaveBrainIdeaArgs {
  content: string
}

export const saveBrainIdeaHandler: ToolHandler<SaveBrainIdeaArgs> = {
  name: 'saveBrainIdea',
  execute: async (args, { queryClient, t }) => {
    const entry = await brainApi.create(args.content)
    queryClient.invalidateQueries({ queryKey: brainKeys.feeds() })
    toast.success(t('brainIdeaSaved', { ns: 'ai', defaultValue: 'Idea saved to brain' }))
    return { success: true, entry: { id: entry.id, status: entry.status } }
  },
}
