export const queryKeys = {
  auth: { me: ['auth', 'me'] },
  tasks: {
    all: ['tasks'],
    today: ['tasks', 'today'],
    weekly: ['tasks', 'weekly'],
    grouped: ['tasks', 'grouped'],
    byId: (id: string) => ['tasks', id],
  },
  habits: {
    all: ['habits'],
    stats: ['habits', 'stats'],
    logs: (id: string) => ['habits', id, 'logs'],
  },
  ai: {
    threads: ['ai', 'threads'],
  },
  profile: ['profile'],
  settings: ['settings'],
  notifications: {
    aggregated: ['notifications', 'aggregated'],
  },
  features: {
    resolved: ['features', 'resolved'],
  },
  gamification: {
    profile: ['gamification', 'profile'],
    streak: ['gamification', 'streak'],
    achievements: ['gamification', 'achievements'],
    challenges: (date?: string) => (date ? ['gamification', 'challenges', date] : ['gamification', 'challenges']),
  },
};
