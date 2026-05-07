# Plan de Acción — The Prime Way Mobile

> **Norte:** Mobile NO es la web. Mobile es un **compañero diario IA-first**: abres, hablas, revisas, actúas.
> La web es el sistema profundo (admin, finanzas, notas, planeación, KYC, suscripción). Mobile mantiene el **momentum diario**.
>
> **Fecha del plan:** 2026-05-06

---

## Principio rector

> "La app debe hacer que el usuario piense menos: abrir, hablar, revisar, actuar."

Cada decisión de producto se mide contra esta vara. Si una pantalla agrega fricción cognitiva o requiere "administrar", **no va en mobile**.

---

## Navegación

Solo **3 pestañas**. Bottom tab bar.

| Tab | Rol | Slug |
|---|---|---|
| **IA** | Chat principal — la pantalla por defecto al abrir la app | `(tabs)/ai` |
| **Progreso** | Lectura rápida de "cómo voy" | `(tabs)/index` |
| **Manual** | Acciones rápidas: Tareas \| Hábitos (tabs internas) | `(tabs)/manual` |

Todo lo demás (finanzas, notas, metas profundas, calendario, KYC, suscripción, ajustes pesados) **vive en la web**. Si el usuario lo necesita, abrimos la web en `expo-web-browser`.

---

## Estilo visual

- **Fondos claros**: blanco / lavanda muy suave
- **Tarjetas limpias**: bordes sutiles, sombras ligeras
- **Mucho espacio** (whitespace generoso)
- **Acento**: azul/violeta
- **Sensación**: premium, moderno, simple
- **Tipografía**: sistema, jerarquía clara, sin abuso de pesos
- **Tema**: light por defecto. Dark opcional (no prioridad).

---

## Pantalla 1: IA (default)

**Layout:**
```
┌─────────────────────────────┐
│  Hola André 👋             │  ← saludo corto, contextual
│  ¿Listo para hoy?          │
├─────────────────────────────┤
│                             │
│   [chat empty state]        │
│                             │
│   ▸ Qué debería hacer       │
│     primero hoy?            │
│   ▸ Dame una lectura        │
│     de mi progreso          │
│   ▸ Ayúdame a ordenar       │
│     mis hábitos             │
│                             │
├─────────────────────────────┤
│ 🎤  [ escribe...     ] ➤   │  ← input fijo abajo
└─────────────────────────────┘
```

**Reglas:**
- Mensajes tipo chat (sin cards innecesarias dentro)
- Streaming visible (el cursor parpadea mientras genera)
- Voz: tap holdar el mic → transcribe → envía (o muestra antes de enviar, decidir)
- Sugerencias del empty state desaparecen al primer mensaje
- Las respuestas pueden contener **acciones** (botones inline): "Marcar tarea X completada", "Crear hábito Y", etc.
- El historial de threads vive en un drawer/overlay accesible desde un icono header (no es prominente)

**Stack técnico:**
- `react-native-sse` para streaming desde `/api/chat`
- `expo-speech-recognition` para voz (ya instalado)
- `expo-haptics` en send + en cada acción inline
- `react-native-markdown-display` para markdown en respuestas

---

## Pantalla 2: Progreso

**Layout:**
```
┌─────────────────────────────┐
│  Progreso                   │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │  Nivel 12     1,240 XP  │ │  ← tarjeta principal
│ │  Racha 🔥 7 días         │ │
│ │  ▓▓▓▓▓▓▓░░░  68% día    │ │
│ └─────────────────────────┘ │
│                             │
│ ┌─────┐ ┌─────┐ ┌─────┐     │
│ │ 5/8 │ │ 3/4 │ │+120 │     │  ← métricas pequeñas
│ │tasks│ │hábit│ │ XP  │     │
│ └─────┘ └─────┘ └─────┘     │
│                             │
│  [ Pedir lectura a la IA ]  │  ← CTA grande → abre IA con prompt prellenado
└─────────────────────────────┘
```

**Métricas a mostrar:**
- Tarjeta principal: nivel, XP total, racha, % de progreso del día
- Cards pequeños: tareas completadas hoy (X/Y), hábitos cumplidos (X/Y), XP ganado hoy, racha actual
- CTA al final → navega a `(tabs)/ai` con un prompt prellenado tipo "Dame una lectura de mi progreso"

**Sin gráficas pesadas.** Esto es para leer en 3 segundos.

---

## Pantalla 3: Manual

**Layout:**
```
┌─────────────────────────────┐
│  Manual                     │
├─────────────────────────────┤
│  [ Tareas ]   Hábitos       │  ← segmented control
├─────────────────────────────┤
│  ┌─────────────────────┐    │
│  │ + Añadir tarea...   │    │  ← composer rápido
│  └─────────────────────┘    │
│                             │
│  Hoy: 3 pendientes          │  ← resumen
│                             │
│  ☐ Llamar al cliente        │
│  ☐ Revisar PR de Juan       │
│  ☐ Mandar factura           │
│  ☑ Email diario             │
└─────────────────────────────┘
```

**Tab Tareas:**
- Composer arriba (input + add)
- Resumen de pendientes/completadas del día
- Lista del día (solo hoy — no "all", no "weekly", no "focus")
- Swipe para completar
- Tap para editar (bottom sheet ligero)

**Tab Hábitos:**
- Botón destacado "+ Crear hábito"
- Resumen: activos / completados hoy
- Cards con: check, racha, mini semana (heatmap 7 días)
- Tap en check completa con haptic

**Sin:** auto-scheduling, prioridades complejas, filtros pesados, vista semanal, drag & drop. Eso vive en la web.

---

## Qué se mantiene del código actual

| Feature actual | Decisión |
|---|---|
| `src/features/ai` | ✅ **Mantener y profundizar** — es el corazón |
| `src/features/tasks` | ✅ Mantener, **simplificar** (solo vista de hoy) |
| `src/features/habits` | ✅ Mantener, **simplificar** (cards + check + mini semana) |
| `src/features/notifications` | ✅ Mantener (morning briefing, reminders) |
| `src/features/auth` | ✅ Mantener mínimo |
| `src/features/profile` | ✅ Mínimo: avatar, nombre, logout |
| `src/features/settings` | 🟡 Reducir a: idioma, tema, notificaciones, link "abrir ajustes completos en web" |
| `src/features/calendar` | ❌ **Eliminar** (está en la web) |
| `src/features/pomodoro` | ❌ **Eliminar** (no está en la nueva visión) |
| `src/features/goals` | ❌ **Eliminar** (vive en la web) |
| `src/features/subscription` | ❌ **Eliminar** (gestión va en la web vía WebBrowser) |
| `src/features/notes` | ✅ No existe — **no se crea** |
| `src/features/finances` | ✅ No existe — **no se crea** |
| `src/features/kyc` | ✅ No existe — **no se crea** |

**Rutas a eliminar en `app/(app)/`:** calendar, pomodoro, goals, alignment-setup, subscription, kyc (lo que exista).

---

## Componentes compartidos clave

```
src/shared/components/
├── ui/                       # primitivos (rn-primitives + reusables)
├── chat/
│   ├── ChatBubble.tsx
│   ├── ChatInput.tsx         # input + mic + send
│   ├── ChatSuggestions.tsx   # 3 chips de sugerencias
│   ├── StreamingText.tsx
│   └── ActionButton.tsx      # botón inline en respuesta IA
├── progress/
│   ├── LevelCard.tsx
│   ├── MetricCard.tsx        # las 3 cards pequeñas
│   └── ProgressBar.tsx
├── manual/
│   ├── TaskComposer.tsx
│   ├── TaskRow.tsx
│   ├── HabitCard.tsx         # con check + racha + mini-semana
│   └── HabitSparkline.tsx
└── layout/
    ├── Screen.tsx
    └── TabHeader.tsx         # header simple con título
```

---

## Backend

**No requiere cambios mayores.** El backend ya expone todo lo necesario:
- `POST /api/chat` (streaming SSE) — chat IA
- `GET /api/tasks?grouped=today` — lista del día
- `POST /api/tasks` — crear
- `PATCH /api/tasks/[id]` — completar/editar
- `GET /api/habits` + `POST /api/habits/[id]/logs` — habits + log
- `GET /api/profile` — XP, nivel, racha (ya existe la lógica de gamificación)

Si falta algo específico para la lectura de progreso (ej. endpoint agregado), lo añadimos cuando lleguemos.

---

## Plan de ejecución

### Fase A — Limpieza (medio día)
1. [ ] Eliminar features y rutas descartadas (calendar, pomodoro, goals, subscription, kyc, alignment-setup)
2. [ ] Actualizar tab bar a solo 3 tabs (IA, Progreso, Manual)
3. [ ] Eliminar imports/referencias a lo borrado
4. [ ] Validar `pnpm type-check` limpio

### Fase B — IA primero (1-2 días)
5. [ ] Rediseñar `(tabs)/ai.tsx` con el nuevo layout (saludo, sugerencias, input fijo)
6. [ ] Componentes `ChatBubble`, `ChatInput`, `ChatSuggestions`, `StreamingText`
7. [ ] Voz: hook `useVoiceInput` con `expo-speech-recognition`
8. [ ] Acciones inline en respuestas IA (parser + render)
9. [ ] Drawer de threads anteriores

### Fase C — Progreso (medio día)
10. [ ] Pantalla `(tabs)/index.tsx` (Progreso) con `LevelCard` + 3 `MetricCard`
11. [ ] CTA "Pedir lectura" → navega a IA con prompt prellenado
12. [ ] Endpoint o agregación para los datos del día

### Fase D — Manual (1 día)
13. [ ] Pantalla `(tabs)/manual.tsx` con segmented control Tareas/Hábitos
14. [ ] `TaskComposer` (input rápido + add)
15. [ ] `TaskRow` (swipe to complete, tap to edit)
16. [ ] `HabitCard` (check, racha, mini-semana)
17. [ ] Bottom sheet ligero para crear/editar hábito

### Fase E — Diseño visual (medio día)
18. [ ] Aplicar tema claro lavanda/azul-violeta global
19. [ ] Revisar espaciados, sombras, bordes
20. [ ] Haptics consistentes en acciones clave
21. [ ] Animaciones suaves con `react-native-reanimated`

### Fase F — Profile/Settings mínimos (medio día)
22. [ ] Profile: avatar, nombre, logout
23. [ ] Settings: idioma, tema, notificaciones + link "Ajustes avanzados en la web"

### Fase G — Pulido y release
24. [ ] Splash screen alineado al nuevo diseño
25. [ ] Deep linking: notificación push → pantalla relevante
26. [ ] Build EAS preview → testing
27. [ ] Build EAS production → submit

---

## Lo que NO va a tener mobile (decisiones explícitas)

- ❌ Finanzas, transacciones, presupuestos, deudas, ahorros
- ❌ Notas / editor rich-text
- ❌ Metas profundas (Vision/Pillar/Outcome/QuarterFocus)
- ❌ Calendario / integración Google Calendar
- ❌ Pomodoro
- ❌ KYC
- ❌ Gestión de suscripción (solo "abrir en web")
- ❌ Configuración avanzada (work hours, currency settings, AI sharing) — link a web

---

*Plan actualizado: 2026-05-06 | Versión 2.0 — IA-first*
