import type { ReactNode } from 'react';

// Pure passthrough wrapper. Boot work (loadStoredAuth/loadStoredFeatures)
// runs from app/_layout.tsx so that it fires while the splash is still up
// and the rest of the tree is unmounted.
export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
