/* ============================================================
   La Griglia — Sincronizzazione Firebase Firestore
   Modulo indipendente che si aggancia a app.js senza modificarne
   l'architettura. Usa localStorage come fallback offline.
   ============================================================ */

// Importa Firebase (deve essere caricato prima in index.html)
const firebase = window.firebase;
const { initializeApp } = firebase;
const { getFirestore, enableIndexedDbPersistence, collection, doc, setDoc, getDoc, onSnapshot, writeBatch } = firebase.firestore;

/* ---------- Configurazione Iniziale ---------- */

let db = null; // Istanza Firestore globale

function initFirebase() {
    if (!firebase.apps.length) {
        try {
            db = initializeApp(firebaseConfig);
            enableIndexedDbPersistence(db)
                .then(() => {
                    console.log('✅ Firestore persistence enabled');
                })
                .catch(err => {
                    // Se IndexedDB non è disponibile (es. alcune sandbox), usa cache memory
                    console.log('⚠️ IndexedDB non disponibile, usando cache in memoria:', err);
                });
        } catch (error) {
            console.error('❌ Errore inizializzazione Firebase:', error);
            return false;
        }
    }
    return db;
}

/* ---------- Funzioni di Sincronizzazione ---------- */

/**
 * Salva lo stato corrente del ristorante in Firestore.
 * @param {Object} stateData - Oggetto contenente rooms, tables, groups, reservations, nextTableId, nextGroupId, nextReservationId
 * @returns {Promise<Object>} - Risultato dell'operazione { success: boolean, message: string }
 */
function syncSaveToCloud(stateData) {
    if (!db) {
        return Promise.resolve({ success: false, message: 'Firebase non inizializzato. Dati salvati solo in localStorage.' });
    }

    // Crea batch per evitare multiple write operations separate
    const batch = db.batch();
    
    const restaurantRef = doc(collection(db, 'restaurants'));
    const batchOps = [];

    // Salva ogni collezione come documento separato nella collection "restaurants"
    if (stateData.rooms && Array.isArray(stateData.rooms)) {
        batchOps.push(setDoc(doc(restaurantRef, 'rooms', stateData.rooms.length), {
            type: 'rooms',
            data: stateData.rooms
        }));
    }

    if (stateData.tables && Array.isArray(stateData.tables)) {
        batchOps.push(setDoc(doc(restaurantRef, 'tables', stateData.tables.length), {
            type: 'tables',
            data: stateData.tables
        }));
    }

    if (stateData.groups && Array.isArray(stateData.groups)) {
        batchOps.push(setDoc(doc(restaurantRef, 'groups', stateData.groups.length), {
            type: 'groups',
            data: stateData.groups
        }));
    }

    if (stateData.reservations && Array.isArray(stateData.reservations)) {
        batchOps.push(setDoc(doc(restaurantRef, 'reservations', stateData.reservations.length), {
            type: 'reservations',
            data: stateData.reservations
        }));
    }

    if (typeof stateData.nextTableId === 'number') {
        batchOps.push(setDoc(doc(restaurantRef, 'nextTableId'), stateData.nextTableId));
    }

    if (typeof stateData.nextGroupId === 'number') {
        batchOps.push(setDoc(doc(restaurantRef, 'nextGroupId'), stateData.nextGroupId));
    }

    if (typeof stateData.nextReservationId === 'number') {
        batchOps.push(setDoc(doc(restaurantRef, 'nextReservationId'), stateData.nextReservationId));
    }

    // Esegui batch se ci sono operazioni
    if (batchOps.length > 0) {
        const batchPromise = batch.commit();
        
        return new Promise((resolve) => {
            batch.then(() => {
                resolve({ success: true, message: 'Dati salvati nel cloud.' });
            }).catch(err => {
                console.error('❌ Errore salvataggio batch Firestore:', err);
                resolve({ success: false, message: 'Errore salvataggio cloud. I dati restano in localStorage.' });
            });
        });
    } else {
        // Nessun dato da salvare
        return Promise.resolve({ success: true, message: 'Nessun dato da sincronizzare.' });
    }
}

/**
 * Carica lo stato dal cloud Firestore e aggiorna il locale.
 * @returns {Promise<Object|null>} - Stato caricato o null se non disponibile
 */
function syncLoadFromCloud() {
    if (!db) {
        return Promise.resolve(null);
    }

    const restaurantRef = doc(collection(db, 'restaurants'));

    // Leggi tutti i documenti della collection "restaurants"
    return new Promise((resolve) => {
        getDoc(restaurantRef)
            .then(docSnap => {
                if (!docSnap.exists()) {
                    console.log('📭 Nessun dato trovato nel cloud. Uso localStorage.');
                    resolve(null);
                    return;
                }

                const data = docSnap.data();
                
                // Estrai i dati da sotto-documenti (se usiamo struttura nidificata)
                const rooms = data.rooms?.data || null;
                const tables = data.tables?.data || null;
                const groups = data.groups?.data || null;
                const nextTableId = data.nextTableId !== undefined ? data.nextTableId : null;
                const nextGroupId = data.nextGroupId !== undefined ? data.nextGroupId : null;
                const nextReservationId = data.nextReservationId !== undefined ? data.nextReservationId : null;

                resolve({
                    rooms,
                    tables,
                    groups,
                    nextTableId,
                    nextGroupId,
                    nextReservationId
                });
            })
            .catch(err => {
                console.error('❌ Errore caricamento Firestore:', err);
                resolve(null);
            });
    });
}

/**
 * Listener real-time per sincronizzazione automatica.
 * Aggiorna lo stato locale quando il cloud cambia.
 * @param {Function} onUpdate - Callback chiamato quando lo stato viene aggiornato dal cloud
 */
function startRealtimeSync(onUpdate) {
    if (!db) {
        console.log('⚠️ Firebase non inizializzato, realtime sync disabilitato.');
        return;
    }

    const restaurantRef = doc(collection(db, 'restaurants'));

    onSnapshot(restaurantRef, (snapshot) => {
        if (!snapshot.exists()) {
            console.log('📭 Cloud vuoto, uso localStorage.');
            return;
        }

        const data = snapshot.data();
        
        // Estrai dati
        const rooms = data.rooms?.data || null;
        const tables = data.tables?.data || null;
        const groups = data.groups?.data || null;
        const nextTableId = data.nextTableId !== undefined ? data.nextTableId : null;
        const nextGroupId = data.nextGroupId !== undefined ? data.nextGroupId : null;
        const nextReservationId = data.nextReservationId !== undefined ? data.nextReservationId : null;

        // Chiamata callback con nuovo stato
        onUpdate({
            rooms,
            tables,
            groups,
            nextTableId,
            nextGroupId,
            nextReservationId
        });
    }, (error) => {
        console.error('❌ Errore listener Firestore:', error);
    });
}

/* ---------- Integrazione con app.js ---------- */

// Esporta le funzioni per essere usate da app.js se necessario
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initFirebase, syncSaveToCloud, syncLoadFromCloud, startRealtimeSync };
}