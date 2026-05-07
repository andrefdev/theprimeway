# Splash hang debug plan

## Estado actual

- ✅ Build de iOS **compila correctamente** después de configurar capabilities en Apple Developer (App Groups + Sign in with Apple en ambos Bundle IDs: `com.indrox.theprimeway` y `com.indrox.theprimeway.widget`).
- ❌ El app instalado se queda en el **splash screen** y nunca carga, en iOS y Android.

## Cambios aplicados hoy

- Instalado `expo-apple-authentication@~55.0.13`
- Agregado plugin `expo-apple-authentication` en `app.json`
- Agregado `ios.appleTeamId: "P7S9GFT5VQ"` en `app.json`
- Creado App Group `group.com.indrox.theprimeway` en Apple Developer y asignado a ambos Bundle IDs

## Lo que ya verifiqué

- `npx tsc --noEmit` pasa limpio → **no hay imports rotos** después de las renames de `notifications/`
- No hay referencias a archivos borrados (`repo-shared/`)
- `eas.json` tiene `EXPO_PUBLIC_API_URL` definido correctamente para production (`https://api.theprimeway.app`)
- El splash se oculta cuando `useAuthStore.isLoading` pasa a `false` (en `app/_layout.tsx:43-47`). `loadStoredAuth` cierra todos los caminos con `set({ isLoading: false })`, así que en teoría no debería colgarse — a menos que algo más arriba en el árbol falle antes.

## Plan para mañana

### Paso 1 — Aislar dev vs prod (5 min)

```powershell
npx expo start --tunnel
```

Abrir el app en el dev client. Dos resultados:

- **Si dev también se queda en splash** → bug de JS, ver consola del dev client. Buscar errores rojos de import o de runtime.
- **Si dev funciona** → es problema específico de producción (Hermes, env vars, minificación, native module). Ir a Paso 2.

### Paso 2 — Si solo falla en prod, abrir logs nativos

**iOS** (con Xcode o el Mac):
```
xcrun simctl spawn booted log stream --predicate 'subsystem contains "com.indrox"'
```
O conectar el dispositivo y ver Console.app.

**Android**:
```powershell
adb logcat *:E ReactNativeJS:V
```

Instalar el APK/AAB y abrirlo. Buscar excepciones JS o nativas.

### Paso 3 — Sospechosos principales

1. **Native module `widget-bridge`** (`modules/widget-bridge/`) — es un módulo local custom. Si su iniciación falla en prod, puede romper el JS bundle al hacer `import` de él. Verificar si está siendo importado a nivel de módulo en algún archivo cargado al inicio.

2. **`registerMutationDefaults()`** se ejecuta a nivel de módulo en `app/_layout.tsx:37`. Si lanza error, todo el módulo falla a cargar. Envolverlo en try/catch puede ayudar a diagnosticar.

3. **`SplashScreen.preventAutoHideAsync()`** se ejecuta a nivel de módulo. Si nada después llama a `hideAsync()`, queda colgado para siempre. Agregar un timeout de safety:
   ```ts
   SplashScreen.preventAutoHideAsync();
   setTimeout(() => SplashScreen.hideAsync().catch(() => {}), 5000); // fallback
   ```

4. **`react-native-worklets/plugin`** en `babel.config.js`. Verificar que la versión instalada de `react-native-reanimated` sea compatible con el plugin de worklets (Reanimated 4.x usa `react-native-worklets/plugin`, anteriores usan `react-native-reanimated/plugin`).

5. **`expo-apple-authentication`** recién instalado — verificar que la versión es compatible con tu SDK (instalada `~55.0.13` para SDK 55.0.0, debería estar bien).

### Paso 4 — Quick win para no quedarse bloqueado

Aunque no diagnostiquemos la causa raíz, agregar el timeout fallback al splash en `app/_layout.tsx` evita que se quede infinito y al menos podremos ver qué muestra el app después:

```ts
SplashScreen.preventAutoHideAsync();
const SPLASH_FALLBACK_MS = 8000;
setTimeout(() => {
  SplashScreen.hideAsync().catch(() => {});
}, SPLASH_FALLBACK_MS);
```

Si después del splash aparece la pantalla de login o de error → confirmamos que el problema es solo en `loadStoredAuth` o el splash gating. Si sigue negro → hay un crash de render más profundo.

## Información relevante para retomar

- Bundle IDs configurados:
  - App: `com.indrox.theprimeway`
  - Widget: `com.indrox.theprimeway.widget`
- App Group: `group.com.indrox.theprimeway` (asignado a ambos)
- Apple Team ID: `P7S9GFT5VQ`
- Build URL del último intento: https://expo.dev/accounts/indroxdev/projects/theprimeway/builds/3b6aa8cc-17dc-4402-9fb8-dcda8b4657df
