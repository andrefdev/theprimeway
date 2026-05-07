import { tool } from 'ai'
import { z } from 'zod'

export function brainClientTools() {
  return {
    saveBrainIdea: tool({
      description:
        "Propose saving the user's idea, thought, reflection, or insight as a brain entry. Use only when the user clearly expresses something worth keeping in their second brain. Requires user approval in the UI. The brain pipeline async-generates title, summary, topics, and action items.",
      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .describe("The raw idea/thought text in the user's own words"),
      }),
    }),
  }
}
