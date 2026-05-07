import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import type { ResolvedFeatureSet } from '@repo/shared/types'

const FEATURES_KEY = 'feature_set'

interface FeaturesState {
  features: ResolvedFeatureSet | null
  resolvedAt: string | null
  setFeatures: (features: ResolvedFeatureSet, resolvedAt: string) => void
  loadStoredFeatures: () => Promise<void>
  clearFeatures: () => Promise<void>
}

export const useFeaturesStore = create<FeaturesState>((set) => ({
  features: null,
  resolvedAt: null,

  setFeatures: (features, resolvedAt) => {
    set({ features, resolvedAt })
    // Persist to SecureStore asynchronously
    SecureStore.setItemAsync(FEATURES_KEY, JSON.stringify({ features, resolvedAt })).catch(() => {})
  },

  loadStoredFeatures: async () => {
    const __t = Date.now()
    const __l = (m: string) => console.log(`[BOOT-FEAT +${Date.now() - __t}ms] ${m}`)
    __l('loadStoredFeatures ENTER')
    try {
      __l('before SecureStore.getItemAsync FEATURES_KEY')
      const raw = await SecureStore.getItemAsync(FEATURES_KEY)
      __l(`after SecureStore.getItemAsync raw=${raw ? 'present' : 'null'}`)
      if (raw) {
        const { features, resolvedAt } = JSON.parse(raw)
        set({ features, resolvedAt })
      }
      __l('loadStoredFeatures DONE')
    } catch (e) {
      __l('loadStoredFeatures CATCH: ' + String((e as Error)?.message ?? e))
    }
  },

  clearFeatures: async () => {
    set({ features: null, resolvedAt: null })
    await SecureStore.deleteItemAsync(FEATURES_KEY)
  },
}))
