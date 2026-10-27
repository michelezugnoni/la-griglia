# La Griglia su Android

L'applicazione è ora una **PWA** (Progressive Web App): si installa dal browser
Android, ha un'icona propria, si apre a schermo intero e funziona **anche offline**.
Non serve rifare nulla: sono gli stessi file `index.html`, `style.css`, `app.js`.

## Cosa è stato aggiunto

| File | Scopo |
| --- | --- |
| `manifest.webmanifest` | Nome, icona, colori, avvio a schermo intero |
| `sw.js` | Service worker: mette in cache l'interfaccia per l'uso offline |
| `icons/*.png` | Icone 192/512 px, maskable, apple-touch, favicon |
| `index.html` | Meta tag PWA, icona, pulsante **Installa app** |
| `app.js` | Registrazione del service worker + gestione del pulsante Installa |
| `style.css` | Aree sicure (notch/barra gesti) e stile del pulsante Installa |

I dati (sale, tavoli, prenotazioni) restano dove sono sempre stati: `localStorage`
del dispositivo. Non vengono inviati da nessuna parte.

## Provarla da telefono

Il service worker e l'installazione richiedono **HTTPS** oppure `localhost`.
Aprire il file con `file://` o via `http://192.168.x.x` funziona, ma senza
installazione e senza offline. Per provarla davvero:

1. pubblica la cartella su un host statico (GitHub Pages, Netlify, Vercel, Cloudflare Pages…);
2. apri l'indirizzo sul telefono con Chrome;
3. menu ⋮ → **Installa app** (oppure il pulsante **Installa app** in alto).

Da quel momento l'icona "La Griglia" è nella schermata Home e l'app si apre
senza barra degli indirizzi.

## Ottenere un vero file .apk

Un APK non si può compilare qui: servono JDK e Android SDK, non installati su
questo computer. Due strade pratiche:

### A. PWABuilder (nessuna installazione, consigliata)

1. pubblica l'app come sopra e copia l'URL pubblico;
2. vai su <https://www.pwabuilder.com>, incolla l'URL e analizza;
3. scegli **Android** → scarica il pacchetto (`.apk` per installazione diretta,
   `.aab` per Google Play).

PWABuilder genera una Trusted Web Activity: è l'app Chrome senza interfaccia
del browser. Per la pubblicazione sul Play Store servono la firma e il file
`assetlinks.json` sul dominio (PWABuilder li prepara e spiega dove metterli).

### B. Progetto Android nativo (WebView)

In alternativa si può creare un progetto Android Studio con una `WebView` che
carica i file da `assets/www`, più un workflow GitHub Actions che produce
l'APK a ogni push. Richiede Android Studio (o JDK 17 + Android SDK) per la
compilazione locale.
