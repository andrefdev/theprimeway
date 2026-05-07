import { create } from 'zustand';

interface UiState {
  badgeCounts: {
    tasks: number;
    notifications: number;
  };
  focusModeSilence: boolean;
  setFocusModeSilence: (v: boolean) => void;
  setBadgeCount: (key: 'tasks' | 'notifications', count: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  badgeCounts: { tasks: 0, notifications: 0 },
  focusModeSilence: true,

  setFocusModeSilence: (v) => set({ focusModeSilence: v }),

  setBadgeCount: (key, count) =>
    set((state) => ({ badgeCounts: { ...state.badgeCounts, [key]: count } })),
}));
