// Firebase Cloud Messaging service worker.
// Placeholders (__FB_*__) are replaced at Docker build time via sed from
// VITE_FIREBASE_* build args (see apps/web/Dockerfile).
// For local dev: replace them manually or leave blank (FCM will no-op).
// Firebase project: theprimeway (sender 1088238129956). appId MUST be the
// 1:NUM:web:HASH value — an invalid appId makes getToken() fail silently.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js')

firebase.initializeApp({
  apiKey: '__FB_API_KEY__',
  authDomain: '__FB_AUTH_DOMAIN__',
  projectId: '__FB_PROJECT_ID__',
  messagingSenderId: '__FB_MESSAGING_SENDER_ID__',
  appId: '__FB_APP_ID__',
})

const messaging = firebase.messaging()

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'ThePrimeWay'
  const body = payload.notification?.body || ''
  const url = payload.data?.url || '/'
  const tag = payload.data?.tag || undefined

  self.registration.showNotification(title, {
    body,
    icon: '/web-app-manifest-192x192.png',
    badge: '/favicon-32x32.png',
    data: { url },
    tag,
  })
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(url) && 'focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow(url)
    }),
  )
})
