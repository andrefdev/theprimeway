# The Prime Way — Mobile Architecture

> **Norte del producto:** mobile = compañero diario IA-first. 3 tabs (IA / Progreso / Manual). NO duplica la web.
> Para el qué, lee [`PLAN_DE_ACCION.md`](./PLAN_DE_ACCION.md). Este documento es el **cómo** — convenciones de código que TODO contributor (humano o IA) DEBE seguir.

---

## 1. Tech stack

| Layer | Tech | Versión |
|---|---|---|
| Framework | Expo SDK | 55 |
| Runtime | React Native | 0.83.6 |
| UI | React | 19.2 |
| Styling | NativeWind (Tailwind v3) | 4.2 |
| Router | Expo Router | 55.x (file-based) |
| Server state | TanStack Query | 5 |
| Local state | Zustand | 5 |
| HTTP | Axios via `@shared/api/client` | — |
| Forms | React Hook Form + Zod | — |
| Iconos | `lucide-react-native` | — |
| Listas | `@shopify/flash-list` | 2.x |
| Imágenes | `expo-image` | — |
| Animaciones | `react-native-reanimated` | 4.x |
| Bottom sheets | `@gorhom/bottom-sheet` | 5.x |
| Storage seguro | `expo-secure-store` (tokens), `react-native-mmkv` (prefs) | — |
| Voz | `expo-speech-recognition` | — |
| Image picker | `expo-image-picker` | — |
| Package manager | **pnpm** (workspace) | 9.x |

### Reglas de stack

| ❌ NO usar | ✅ Usar |
|---|---|
| `npm` / `yarn` | `pnpm` |
| `StyleSheet.create` | clases NativeWind |
| `FlatList` / `SectionList` | `FlashList` |
| `Image` de RN | `expo-image` |
| `Animated` de RN | `react-native-reanimated` |
| `AsyncStorage` directo | `expo-secure-store` o MMKV |
| `fetch()` directo | `apiClient` de `@shared/api/client` |
| `Context` para estado global | Zustand |
| Tailwind v4 | Tailwind **v3** |
| Strings hardcodeados en UI | `useTranslation()` con keys en `src/i18n/{en,es}.json` |

---

## 2. Estructura del proyecto

```
apps/mobile/
├── app/                          # Expo Router — solo thin routers
│   ├── _layout.tsx               # Providers (Query, Auth, Theme)
│   ├── index.tsx                 # Redirect: auth → /(app)/(tabs)/ai
│   ├── (auth)/                   # Login, register, OTP, forgot
│   ├── (onboarding)/             # Welcome, goals, habits, tasks
│   └── (app)/                    # Protegido (auth guard en _layout)
│       ├── (tabs)/               # Bottom tab bar — solo 3 tabs
│       │   ├── _layout.tsx       # initialRouteName="ai"
│       │   ├── ai.tsx            # IA (default)
│       │   ├── index.tsx         # Progreso
│       │   └── manual.tsx        # Manual (Tareas | Hábitos)
│       ├── profile.tsx
│       ├── settings.tsx
│       ├── notifications.tsx
│       ├── delete-account.tsx
│       └── error.tsx
│
├── src/
│   ├── features/                 # Módulos de dominio
│   │   ├── ai/
│   │   ├── auth/
│   │   ├── feature-flags/
│   │   ├── gamification/
│   │   ├── habits/
│   │   ├── notifications/
│   │   ├── onboarding/
│   │   ├── profile/
│   │   ├── settings/
│   │   ├── tasks/
│   │   └── widgets/
│   │
│   ├── shared/
│   │   ├── api/                  # client.ts, endpoints.ts, queryKeys.ts
│   │   ├── components/
│   │   │   ├── ui/               # primitivos (button, card, input, ...)
│   │   │   ├── layout/           # Header, Screen
│   │   │   ├── feedback/         # EmptyState, ErrorState, Skeleton
│   │   │   └── data-display/     # PriorityIndicator, etc.
│   │   ├── hooks/                # cross-feature: useTranslation, useDebounce
│   │   ├── providers/            # AuthProvider, QueryProvider, ThemeProvider
│   │   ├── stores/               # Zustand: auth, settings, ui, biometric
│   │   ├── types/models.ts       # tipos de dominio compartidos
│   │   ├── utils/                # cn, date, currency, format
│   │   └── repo-shared/          # tipos compartidos con backend (`@repo/shared`)
│   │
│   └── i18n/
│       ├── en.json
│       ├── es.json
│       └── index.ts
│
├── assets/                       # imágenes, fuentes
├── modules/widget-bridge/        # módulo nativo (iOS widgets)
├── targets/                      # iOS app extensions (@bacons/apple-targets)
├── plugins/                      # config plugins (with-android-widget.js)
├── docs/
│   ├── ARCHITECTURE.md           # este archivo
│   ├── PLAN_DE_ACCION.md
│   └── AI_RULES.md
├── app.json
├── babel.config.js
├── metro.config.js
├── tailwind.config.js
└── tsconfig.json
```

---

## 3. Convención de features ⚠️ (CRÍTICA)

### 3.1 Cada feature DEBE tener un `index.ts` (barrel)

```
src/features/<feature>/
├── components/
├── hooks/
├── services/
├── types.ts          (opcional)
└── index.ts          ← API pública del feature
```

El `index.ts` re-exporta SOLO lo que el resto del código puede consumir. Todo lo demás es interno al feature.

**Ejemplo (`src/features/tasks/index.ts`):**
```ts
export { TaskCard } from './components/TaskCard';
export { TaskComposer } from './components/TaskComposer';
export { TaskEditSheet } from './components/TaskEditSheet';
export {
  useTasks,
  useTasksGrouped,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
} from './hooks/useTasks';
export { tasksService } from './services/tasksService';
export * from './types';
```

### 3.2 Cross-feature imports → SOLO via barrel

```ts
// ✅ CORRECTO — desde otro feature o desde app/
import { TaskCard, useTasks } from '@features/tasks';
import { useGamificationStore, LevelBadge } from '@features/gamification';

// ❌ PROHIBIDO — imports profundos cross-feature
import { TaskCard } from '@features/tasks/components/TaskCard';
import { useGamificationStore } from '@features/gamification/stores/gamificationStore';
```

**Por qué:** renombrar/mover internos del feature no rompe consumidores externos. El barrel ES el contrato público. Si cambia, es un cambio breaking explícito.

### 3.3 Dentro del propio feature → imports relativos

```ts
// ✅ CORRECTO — dentro de src/features/tasks/components/TaskCard.tsx
import { useTasks } from '../hooks/useTasks';
import type { Task } from '../types';

// ❌ PROHIBIDO — un feature NUNCA importa su propio barrel (causa ciclos)
import { useTasks } from '@features/tasks';
```

### 3.4 Capas (regla de dependencia)

```
app/  →  features/  →  shared/
```

- `app/*` puede importar de `@features/*` (via barrel) y de `@shared/*`
- `@features/X` puede importar de `@features/Y` (via barrel) y de `@shared/*`
- `@shared/*` NO puede importar de `@features/*` (sería un ciclo de capa)

### 3.5 Tipos: dónde vive cada cosa

Hay tres clases de tipos. Cada una vive en su lugar:

| Clase | Ejemplo | Ubicación |
|---|---|---|
| **Wire format del API** (DTO de request) | `CreateTaskInput`, `CreateHabitInput` | `packages/shared/src/validators/*` — importado desde mobile vía `@repo/shared/validators` |
| **Response shapes del API** | `Task`, `Habit`, `HabitStats`, `TasksGroupedResponse`, `GetTasksParams` | `packages/shared/src/types/*` — importado desde mobile vía `@repo/shared/types`. Si hay un response shape específico que aún no está en shared, vive temporalmente en `features/<feature>/types.ts` y se migra cuando toque |
| **UI-only (esquema del FORM)** | `taskFormSchema`, `TaskFormData`, `habitFormSchema`, `HabitFormData` | **`apps/mobile/src/shared/types/forms.ts`** (mobile-only — el form del mobile NO es el del web) |

**Nota:** mobile importa el paquete real `@repo/shared` directamente vía aliases en `tsconfig.json` y `babel.config.js` (`'@repo/shared': '../../packages/shared/src'`). NO hay mirror manual.

Los features re-exportan los form types desde su barrel:
```ts
// src/features/tasks/types.ts
export { taskFormSchema, type TaskFormData } from '@shared/types/forms';
```

Así los consumidores siguen importando `from '@features/tasks'`.

### 3.6 `app/` = thin routers

Las pantallas en `app/(*)/*.tsx` deben ser delgadas: importar el panel desde el feature y renderizar. Si un archivo en `app/` supera ~80 líneas o contiene fetch/business logic, hay que mover esa lógica a `src/features/<feature>/`.

```tsx
// ✅ CORRECTO — app/(app)/(tabs)/ai.tsx
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChatPanel } from '@features/ai';

export default function AiChatScreen() {
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ChatPanel />
    </SafeAreaView>
  );
}
```

---

## 4. Patrones de código

### 4.1 Service (raw HTTP, sin React)

```ts
// src/features/<feature>/services/<feature>Service.ts
import { apiClient } from '@shared/api/client';
import { TASKS } from '@shared/api/endpoints';
import type { Task } from '@shared/types/models';

export const tasksService = {
  list: (params?: GetTasksParams) =>
    apiClient.get<Task[]>(TASKS.BASE, { params }).then((r) => r.data),

  create: (data: CreateTaskDto) =>
    apiClient.post<Task>(TASKS.BASE, data).then((r) => r.data),

  update: (id: string, data: Partial<Task>) =>
    apiClient.put<Task>(TASKS.BY_ID(id), data).then((r) => r.data),

  delete: (id: string) => apiClient.delete(TASKS.BY_ID(id)),
};
```

### 4.2 Hook (React Query wrapper)

```ts
// src/features/<feature>/hooks/use<Feature>.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/queryKeys';
import { tasksService } from '../services/tasksService';

export function useTasks(params?: GetTasksParams) {
  return useQuery({
    queryKey: queryKeys.tasks.list(params),
    queryFn: () => tasksService.list(params),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tasksService.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks.all }),
  });
}
```

### 4.3 Component

```tsx
// src/features/<feature>/components/<Component>.tsx
import { View, Pressable } from 'react-native';
import { Text } from '@shared/components/ui/text';
import { Card, CardContent } from '@shared/components/ui/card';
import { cn } from '@shared/utils/cn';
import type { Task } from '@shared/types/models';

interface TaskCardProps {
  task: Task;
  onToggle: (id: string) => void;
}

export function TaskCard({ task, onToggle }: TaskCardProps) {
  return (
    <Card className={cn(task.status === 'completed' && 'opacity-60')}>
      <CardContent>
        <Text className="text-sm font-semibold text-foreground">{task.title}</Text>
      </CardContent>
    </Card>
  );
}
```

### 4.4 Bottom sheet (forms de crear/editar)

Todos los flujos de crear/editar entidades usan `@gorhom/bottom-sheet` envuelto en `FormSheet` (`@shared/components/ui/form-sheet`). Nunca usar `Dialog` para forms.

### 4.5 Estado global

| Tipo de estado | Dónde vive |
|---|---|
| Server state (cualquier cosa que viene de la API) | TanStack Query |
| Auth (token, user) | `useAuthStore` |
| Settings persistidas (locale, theme, biometric) | `useSettingsStore`, `useBiometricStore` |
| UI efímera (active sheet, pomodoro running, badge counts) | `useUiStore` |
| Gamificación (XP, nivel, racha) | `useGamificationStore` |

**Regla:** si la fuente de verdad es el server, NO duplicar en Zustand. Si Zustand persiste algo del server, debe ser explícito como caché read-only sincronizada por el hook.

---

## 5. Path aliases

```
@/*         → src/
@ui/*       → src/shared/components/ui/
@features/* → src/features/
@shared/*   → src/shared/
@assets/*   → assets/
@repo/shared/* → src/shared/repo-shared/
```

Configurados en `tsconfig.json` y `babel.config.js` (resolver). Usar **siempre** alias, nunca relativos profundos como `../../../shared/`.

**Excepción:** dentro del mismo feature, usar relativos (`../hooks/useTasks`) para evitar ciclos con el barrel.

---

## 6. i18n

- Locales: `en` (default) y `es` en `src/i18n/{en,es}.json`
- Hook: `useTranslation('features.<scope>')` — devuelve `t(key, params)` con namespacing
- Cambio de idioma: `setLocale('en' | 'es')` desde `src/i18n/index.ts`; persistido en `useSettingsStore`
- **NUNCA** strings hardcodeados en UI. Si ves `Alert.alert('Error', 'Could not...')`, mover a i18n

```ts
const { t } = useTranslation('features.tasks');
return <Text>{t('actions.create')}</Text>;
```

---

## 7. API integration

- **Base URL**: `EXPO_PUBLIC_API_URL` (por entorno en `eas.json`)
- **Auth**: Bearer JWT auto-inyectado por interceptor de Axios
- **Endpoints**: constantes en `@shared/api/endpoints.ts` (NO strings sueltos en services)
- **Query keys**: factory en `@shared/api/queryKeys.ts`
- **Defaults Query**: `staleTime: 5min`, `gcTime: 30min`, `retry: 2`, `refetchOnWindowFocus: false`
- **401**: el interceptor hace logout automático y redirige a login
- **Streaming (chat IA)**: SSE custom via `fetch().body.getReader()` con protocolo Vercel AI SDK; ver `src/features/ai/services/chatService.ts`

---

## 8. Diseño visual

> **Estado actual:** tema dark heredado del plan v1.
> **Norte v2 (pendiente migración):** fondos claros, blanco / lavanda suave, acento azul/violeta, mucho whitespace, premium.

Cuando se migre, **NO hardcodear hex**. Cambiar tokens en `global.css` (variables CSS) y `tailwind.config.js`. Las clases (`bg-primary`, `text-foreground`, etc.) no cambian.

Tokens semánticos a respetar siempre:
- `success` (verde) — completado, positivo
- `destructive` (rojo) — eliminar, error, alta prioridad
- `warning` (ámbar) — precaución, prioridad media
- `info` (azul) — neutral, prioridad baja

---

## 9. Reglas de no-go (qué nunca hacer en mobile)

Mobile es complemento, no réplica. **NO** se implementa en mobile:
- Finanzas (transacciones, presupuestos, deudas, ahorros)
- Notas / editor rich-text
- Metas profundas (Vision/Pillar/Outcome/QuarterFocus)
- Calendario / Google Calendar
- Pomodoro
- KYC
- Gestión de suscripción (solo "abrir en web")
- Configuración avanzada de work hours, currency, AI sharing

Si alguien pide agregar uno de estos, redirigirlo al plan: la web ya lo tiene; mobile abre la web vía `expo-web-browser`.

---

## 10. Checklist antes de mergear

- [ ] Cero imports profundos cross-feature (`@features/X/components/...`)
- [ ] Cero ciclos: ningún archivo dentro de `features/X` importa `@features/X`
- [ ] `pnpm type-check` pasa
- [ ] Cero `StyleSheet.create`, cero hex hardcodeados
- [ ] Strings en UI usan `useTranslation`
- [ ] Si tocaste un screen de `app/(*)/...` y supera ~80 líneas, considerar mover lógica a `src/features/<feature>/screens/`
- [ ] Listas con >20 items usan `FlashList`, no `FlatList`
- [ ] Forms en bottom sheet (no Dialog)

---

## 11. Comandos útiles

```powershell
# Dev
pnpm dev              # expo start -c
pnpm android          # expo start -c --android
pnpm ios              # expo start -c --ios

# Verificación
pnpm type-check       # tsc --noEmit
pnpm lint             # eslint src/ app/

# Build
pnpm build:android    # eas build --platform android
pnpm build:preview    # eas build --profile preview --platform all
```

---

*Última actualización: 2026-05-06 — sincronizado con PLAN_DE_ACCION v2 y barrel-export refactor.*
