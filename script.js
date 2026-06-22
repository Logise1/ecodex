import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithCustomToken, signInAnonymously, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- Configuración Global ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
    apiKey: "AIzaSyAnuRzcdEXWXuvlnFCEpgEGg185kamxW-s", authDomain: "ecodex-edd32.firebaseapp.com",
    projectId: "ecodex-edd32", storageBucket: "ecodex-edd32.firebasestorage.app", appId: "1:381601087365:web:8bba38b902a62d0bf28eec"
};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const WORKER_API_URL = "https://ecodex.logise1123.workers.dev/api/scan";

const app = initializeApp(firebaseConfig); const auth = getAuth(app); const db = getFirestore(app); const provider = new GoogleAuthProvider();

// --- Gamificación ---
const XP_REWARDS = { 'LC': 10, 'NT': 30, 'VU': 50, 'EN': 100, 'CR': 250, 'EW': 500, 'EX': 1000, 'UNKNOWN': 0 };
const CONSERVATION_WEIGHT = { 'EX': 7, 'EW': 6, 'CR': 5, 'EN': 4, 'VU': 3, 'NT': 2, 'LC': 1, 'UNKNOWN': 0 };
const ACHIEVEMENTS_DB = {
    'first_step': { id: 'first_step', title: 'Primer Paso', desc: 'Documentaste tu primera especie.', icon: 'footprints', color: 'bg-emerald-100 text-emerald-600' },
    'rare_hunter': { id: 'rare_hunter', title: 'Buscador de Rarezas', desc: 'Encontraste una especie Casi Amenazada o Vulnerable.', icon: 'sparkles', color: 'bg-yellow-100 text-yellow-600' },
    'critical_hero': { id: 'critical_hero', title: 'Héroe Crítico', desc: 'Descubriste una especie en Peligro Crítico o Extinta.', icon: 'shield-alert', color: 'bg-red-100 text-red-600' },
    'collector_5': { id: 'collector_5', title: 'Coleccionista Novato', desc: 'Has registrado 5 especies diferentes en tu EcoDex.', icon: 'library', color: 'bg-blue-100 text-blue-600' }
};

function getLevelFromXP(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1; }
function getXpForLevel(level) { return Math.pow(level - 1, 2) * 50; }

let currentUser = null; let currentUserProfile = null;
let unsubscribeScans = null; let unsubscribeLeaderboard = null;
let pendingAlertsQueue = []; let globalScans = [];
let currentCategory = 'Todos'; let currentSort = 'date_desc';

// Variables de Cámara y Zoom
let cameraStream = null;
let currentFacingMode = 'environment';
let videoTrack = null;
let currentZoom = 1; let minZoom = 1; let maxZoom = 1;

// --- Conservación ---
const CONSERVATION_INFO = {
    'LC': { short: 'LC', full: 'Preocupación Menor', desc: 'No cumple los criterios para categorías de riesgo. Taxones abundantes y de amplia distribución.' },
    'NT': { short: 'NT', full: 'Casi Amenazada', desc: 'No satisface los criterios de riesgo en la actualidad, pero es probable que los satisfaga en un futuro cercano.' },
    'VU': { short: 'VU', full: 'Vulnerable', desc: 'Afronta un alto riesgo de extinción en estado silvestre.' },
    'EN': { short: 'EN', full: 'En Peligro', desc: 'Afronta un riesgo muy alto de extinción en estado silvestre.' },
    'CR': { short: 'CR', full: 'En Peligro Crítico', desc: 'Afronta un riesgo extremadamente alto de extinción en estado silvestre.' },
    'EW': { short: 'EW', full: 'Extinta en Estado Silvestre', desc: 'Solo sobrevive en cultivo, cautividad o como población naturalizada fuera de su distribución original.' },
    'EX': { short: 'EX', full: 'Extinta', desc: 'No existe duda razonable de que el último individuo ha muerto.' },
    'UNKNOWN': { short: 'UNKNOWN', full: 'Desconocido', desc: 'No se tienen datos suficientes para evaluar su riesgo de extinción.' }
};
let currentDetailStatus = 'UNKNOWN';
let isStatusExpanded = false;

lucide.createIcons();

// --- Tabs Navegación ---
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => { b.classList.remove('nav-active'); b.classList.add('nav-inactive'); });
        btn.classList.add('nav-active'); btn.classList.remove('nav-inactive');
        ['view-ecodex', 'view-leaderboard', 'view-profile', 'view-home', 'view-gallery'].forEach(id => {
            const view = document.getElementById(id);
            if (view) view.classList.add('hidden');
        });
        const targetView = document.getElementById(btn.getAttribute('data-target'));
        if (targetView) targetView.classList.remove('hidden');
    });
});

document.querySelectorAll('.cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.cat-tab').forEach(t => { t.classList.remove('tab-active'); t.classList.add('tab-inactive'); });
        tab.classList.add('tab-active'); tab.classList.remove('tab-inactive');
        currentCategory = tab.getAttribute('data-cat');
        filterAndRenderEcodex();
    });
});

document.getElementById('sort-select')?.addEventListener('change', (e) => { currentSort = e.target.value; filterAndRenderEcodex(); });

// --- Lógica del Scroll de Fotos (Dots) ---
document.getElementById('detail-carousel')?.addEventListener('scroll', (e) => {
    const carousel = e.target;
    // Calcular indice actual en base a cuanto se ha escroleado horizontalmente
    const index = Math.round(carousel.scrollLeft / carousel.offsetWidth);
    const dotsContainer = document.getElementById('carousel-dots');
    if (!dotsContainer) return;
    Array.from(dotsContainer.children).forEach((dot, i) => {
        dot.className = `h-1.5 rounded-full transition-all duration-300 ${i === index ? 'bg-white w-3 shadow-md' : 'bg-white/50 w-1.5'}`;
    });
});

// --- Autenticación ---
const initAuth = async () => { if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) await signInWithCustomToken(auth, __initial_auth_token); };
initAuth();

document.getElementById('btn-login')?.addEventListener('click', async () => { try { await signInWithPopup(auth, provider); } catch (error) { showMessage("Error de conexión"); } });
document.getElementById('btn-logout')?.addEventListener('click', () => signOut(auth));
document.getElementById('btn-logout-settings')?.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('login-screen')?.classList.add('hidden');
        document.getElementById('app-screen')?.classList.remove('hidden'); document.getElementById('app-screen')?.classList.add('flex');
        document.getElementById('bottom-nav')?.classList.remove('hidden'); document.getElementById('bottom-nav')?.classList.add('grid');
        await initializeUserProfile(user);
        loadPrivateData(user.uid); loadPublicLeaderboard();
        loadSpeciesOfTheDay();
    } else {
        currentUser = null; currentUserProfile = null; globalScans = [];
        document.getElementById('login-screen')?.classList.remove('hidden');
        document.getElementById('app-screen')?.classList.add('hidden'); document.getElementById('app-screen')?.classList.remove('flex');
        document.getElementById('bottom-nav')?.classList.add('hidden'); document.getElementById('bottom-nav')?.classList.remove('grid');
        if (unsubscribeScans) unsubscribeScans(); if (unsubscribeLeaderboard) unsubscribeLeaderboard();
        stopCamera();
    }
});

async function initializeUserProfile(user) {
    const profileRef = doc(db, 'artifacts', appId, 'public', 'data', 'leaderboard', user.uid);
    const profileSnap = await getDoc(profileRef);
    if (!profileSnap.exists()) {
        currentUserProfile = { uid: user.uid, displayName: user.displayName || "Explorador", photoId: '', fallbackPhoto: user.photoURL || "https://api.dicebear.com/7.x/bottts/svg?seed=" + user.uid, xp: 0, level: 1, achievements: [] };
        await setDoc(profileRef, currentUserProfile);
    } else { currentUserProfile = profileSnap.data(); }
    updateProfileUI();
}

function updateProfileUI() {
    if (!currentUserProfile) return;
    const lvl = getLevelFromXP(currentUserProfile.xp);
    const currentLvlXp = getXpForLevel(lvl); const nextLvlXp = getXpForLevel(lvl + 1);
    const progress = ((currentUserProfile.xp - currentLvlXp) / (nextLvlXp - currentLvlXp)) * 100;

    const updateEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    updateEl('header-level', lvl); updateEl('profile-name', currentUserProfile.displayName);
    updateEl('profile-level-badge', lvl); updateEl('bar-current-lvl', lvl);
    updateEl('bar-current-xp', currentUserProfile.xp); updateEl('bar-next-xp', nextLvlXp);

    const pb = document.getElementById('xp-progress-bar'); if (pb) pb.style.width = `${Math.min(100, Math.max(0, progress))}%`;

    const avatarImg = document.getElementById('profile-avatar');
    if (avatarImg) avatarImg.src = currentUserProfile.photoId ? `https://greenbase.arielcapdevila.com/file/${currentUserProfile.photoId}` : currentUserProfile.fallbackPhoto;

    const grid = document.getElementById('achievements-grid');
    if (grid) {
        grid.innerHTML = ''; const userAch = currentUserProfile.achievements || [];
        if (userAch.length === 0) grid.innerHTML = `<p class="col-span-full text-slate-400 text-sm py-4">Aún no hay trofeos.</p>`;
        else {
            userAch.forEach(achId => {
                const ach = ACHIEVEMENTS_DB[achId]; if (!ach) return;
                grid.innerHTML += `
                            <div class="bg-white border border-slate-100 rounded-3xl p-5 text-center flex flex-col items-center shadow-sm hover:-translate-y-1 transition-transform">
                                <div class="w-14 h-14 rounded-full flex items-center justify-center mb-3 ${ach.color}"><i data-lucide="${ach.icon}" class="w-7 h-7"></i></div>
                                <h4 class="font-bold text-slate-800 text-[10px] uppercase leading-tight mb-1">${ach.title}</h4>
                            </div>`;
            });
            lucide.createIcons();
        }
    }
}

// --- Carga de EcoDex ---
function loadPrivateData(uid) {
    const scansRef = collection(db, 'artifacts', appId, 'users', uid, 'scans');
    unsubscribeScans = onSnapshot(scansRef, (snapshot) => {
        globalScans = []; snapshot.forEach(doc => { globalScans.push({ ...doc.data(), docId: doc.id }); });
        filterAndRenderEcodex();
    }, (err) => console.error(err));
}

function getDocTime(item) {
    if (!item.timestamp) return Date.now();
    if (typeof item.timestamp.toMillis === 'function') return item.timestamp.toMillis();
    if (item.timestamp.seconds) return item.timestamp.seconds * 1000;
    return Date.now();
}

function filterAndRenderEcodex() {
    let filtered = [...globalScans];
    if (currentCategory !== 'Todos') filtered = filtered.filter(item => (item.categoria || 'Otro') === currentCategory);

    filtered.sort((a, b) => {
        if (currentSort === 'date_desc') return getDocTime(b) - getDocTime(a);
        if (currentSort === 'date_asc') return getDocTime(a) - getDocTime(b);
        if (currentSort === 'status') return (CONSERVATION_WEIGHT[b.status] || 0) - (CONSERVATION_WEIGHT[a.status] || 0);
        if (currentSort === 'name') return (a.name || '').localeCompare(b.name || '');
        return 0;
    });
    updateDashboardStats();
    renderEcodex(filtered, globalScans.length);
    renderGallery(filtered);
}

function renderEcodex(scans, totalCount) {
    const grid = document.getElementById('ecodex-grid'); const empty = document.getElementById('empty-state');
    if (!grid || !empty) return;
    const spCount = document.getElementById('species-count'); if (spCount) spCount.textContent = `${totalCount} descubiertas`;

    grid.innerHTML = '';
    if (scans.length === 0) { empty.classList.remove('hidden'); empty.classList.add('flex'); }
    else {
        empty.classList.add('hidden'); empty.classList.remove('flex');
        scans.forEach((data) => {
            const imgUrl = data.imageId ? `https://greenbase.arielcapdevila.com/file/${data.imageId}` : '';
            const displayName = data.name || 'Desconocido';
            const displaySci = data.scientificName || 'Sujeto no identificado';
            const displayCat = data.categoria || 'Otro';
            const locName = data.locationName ? data.locationName.split(',')[0] : 'Ubicación oculta';

            const card = document.createElement('div');
            card.className = 'glass-card rounded-3xl overflow-hidden shadow-sm flex flex-col group relative cursor-pointer hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1 bg-white border border-slate-100';
            card.onclick = () => openSpeciesDetail(data);
            card.innerHTML = `
                        <div class="h-44 w-full overflow-hidden bg-slate-100 relative">
                            <img src="${imgUrl}" alt="${displayName}" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" onerror="this.style.display='none'">
                            <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                            <div class="absolute top-3 right-3 status-${data.status} px-2 py-1 rounded-md border border-white/20 text-[10px] font-bold shadow-md tracking-wide">${data.status}</div>
                            
                            <div class="absolute bottom-3 left-3 bg-black/50 backdrop-blur-md text-white px-2 py-0.5 rounded text-[9px] font-medium uppercase tracking-widest shadow-sm border border-white/10 flex items-center gap-1">
                                <i data-lucide="tag" class="w-2.5 h-2.5"></i> ${displayCat}
                            </div>
                            <div class="absolute bottom-3 right-3 text-white flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <i data-lucide="map-pin" class="w-3 h-3 drop-shadow"></i> <span class="text-[9px] font-semibold drop-shadow truncate max-w-[80px]">${locName}</span>
                            </div>
                        </div>
                        <div class="p-4 flex-1 flex flex-col">
                            <h3 class="text-lg font-outfit font-bold text-slate-800 leading-tight mb-0.5 truncate">${displayName}</h3>
                            <p class="text-[11px] text-slate-500 italic mb-3 truncate font-medium">${displaySci}</p>
                            <div class="mt-auto pt-3 border-t border-slate-100 flex items-center justify-between">
                                <span class="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-md"><i data-lucide="zap" class="w-3 h-3 inline"></i> +${data.xpEarned || 0} XP</span>
                                <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300 group-hover:text-emerald-500 transition-colors"></i>
                            </div>
                        </div>`;
            grid.appendChild(card);
        });
        lucide.createIcons();
    }
}

// --- Leaderboard ---
function loadPublicLeaderboard() {
    const lbRef = collection(db, 'artifacts', appId, 'public', 'data', 'leaderboard');
    unsubscribeLeaderboard = onSnapshot(lbRef, (snapshot) => {
        let users = []; snapshot.forEach(doc => users.push(doc.data()));
        users.sort((a, b) => b.xp - a.xp); renderLeaderboard(users);
    }, (err) => console.error(err));
}

function renderLeaderboard(users) {
    const list = document.getElementById('leaderboard-list'); if (!list) return;
    list.innerHTML = '';
    users.slice(0, 50).forEach((u, index) => {
        const isMe = currentUser && u.uid === currentUser.uid;
        let rankTrophy = `<span class="text-slate-400 font-bold w-6 text-center">${index + 1}</span>`;
        if (index === 0) rankTrophy = `<i data-lucide="award" class="w-6 h-6 text-yellow-500 drop-shadow"></i>`;
        else if (index === 1) rankTrophy = `<i data-lucide="award" class="w-6 h-6 text-slate-400 drop-shadow"></i>`;
        else if (index === 2) rankTrophy = `<i data-lucide="award" class="w-6 h-6 text-amber-600 drop-shadow"></i>`;

        list.innerHTML += `
                    <li class="px-6 py-4 flex items-center gap-4 ${isMe ? 'bg-emerald-50/50' : 'hover:bg-slate-50'} transition-colors">
                        ${rankTrophy}
                        <img src="${u.photoId ? `https://greenbase.arielcapdevila.com/file/${u.photoId}` : u.fallbackPhoto}" class="w-10 h-10 rounded-full border-2 border-white shadow-sm object-cover bg-slate-100" onerror="this.onerror=null; this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${u.uid}'">
                        <div class="flex-1 min-w-0">
                            <p class="text-sm font-bold text-slate-800 truncate">${u.displayName} ${isMe ? '<span class="text-[10px] text-emerald-600 font-normal ml-1 bg-emerald-100 px-1.5 py-0.5 rounded">(Tú)</span>' : ''}</p>
                            <p class="text-xs text-slate-500 font-medium">Nivel ${u.level || getLevelFromXP(u.xp)}</p>
                        </div>
                        <div class="text-right">
                            <span class="text-sm font-bold text-emerald-600">${u.xp}</span><span class="text-[10px] text-slate-400 uppercase block font-medium">XP</span>
                        </div>
                    </li>`;
    });
    lucide.createIcons();
}

// --- Fetch Wikimedia Commons Images ---
async function fetchCommonsImages(scientificName) {
    if (!scientificName || scientificName === "No identificado" || scientificName === "Desconocida") return [];
    try {
        // Buscamos archivos relacionados a ese nombre cientifico
        const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(scientificName)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url&format=json&origin=*`;
        const res = await fetch(url);
        const data = await res.json();
        const imageUrls = [];
        if (data.query && data.query.pages) {
            const pages = Object.values(data.query.pages);
            for (const page of pages) {
                if (page.imageinfo && page.imageinfo[0] && page.imageinfo[0].url) {
                    const imgUrl = page.imageinfo[0].url;
                    // Filtramos solo fotos (evitamos mapas/iconos svg)
                    const title = (page.title || '').toLowerCase();
                    if (title.match(/\.(jpeg|jpg)$/) && !title.includes('map')) {
                        imageUrls.push(imgUrl);
                    }
                }
                if (imageUrls.length >= 3) break; // Queremos 3 extras máximo
            }
        }
        return imageUrls;
    } catch (e) {
        console.error("Error cargando fotos de Wikipedia", e);
        return [];
    }
}

function addSlideToCarousel(imgUrl, labelText, isFirst, index) {
    if (!imgUrl) return;
    const carousel = document.getElementById('detail-carousel');
    const dotsContainer = document.getElementById('carousel-dots');
    if (!carousel || !dotsContainer) return;

    const slide = document.createElement('div');
    slide.className = "shrink-0 w-full h-full snap-center relative";
    slide.innerHTML = `
                <img src="${imgUrl}" class="w-full h-full object-cover" alt="Foto Especie">
                <div class="absolute top-4 left-4 bg-black/50 backdrop-blur text-white px-2 py-1 rounded text-[10px] font-bold z-20 border border-white/20 flex items-center gap-1 shadow-lg">
                    ${isFirst ? '<i data-lucide="user" class="w-3 h-3"></i> ' : '<i data-lucide="globe" class="w-3 h-3"></i> '}${labelText}
                </div>
            `;
    carousel.appendChild(slide);

    const dot = document.createElement('div');
    dot.className = `h-1.5 rounded-full transition-all duration-300 ${isFirst ? 'bg-white w-3 shadow-md' : 'bg-white/50 w-1.5'}`;
    dot.id = `dot-${index}`;
    dotsContainer.appendChild(dot);
}

// --- Modal Detalles ---
async function openSpeciesDetail(data) {
    const modal = document.getElementById('species-detail-modal'); if (!modal) return;
    const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

    // Limpiar carrusel
    const carousel = document.getElementById('detail-carousel');
    const dotsContainer = document.getElementById('carousel-dots');
    if (carousel) carousel.innerHTML = '';
    if (dotsContainer) dotsContainer.innerHTML = '';

    // 1. Añadir la foto del usuario primero
    const mainImgUrl = data.imageId ? `https://greenbase.arielcapdevila.com/file/${data.imageId}` : '';
    addSlideToCarousel(mainImgUrl, 'Tu captura', true, 0);

    // Setear Info de Texto
    setTxt('detail-name', data.name || 'Desconocido');
    setTxt('detail-sci-name', data.scientificName || 'No identificado');

    currentDetailStatus = data.status || 'UNKNOWN';
    isStatusExpanded = false;

    const cat = document.getElementById('detail-category'); if (cat) cat.innerHTML = `<i data-lucide="tag" class="w-3 h-3"></i> <span>${data.categoria || 'Otro'}</span>`;
    const badge = document.getElementById('detail-status'); 
    if (badge) { 
        badge.textContent = currentDetailStatus; 
        badge.className = `absolute bottom-4 right-4 z-20 px-3 py-1 rounded-full font-bold text-sm shadow-lg border border-white/20 status-${currentDetailStatus} cursor-pointer hover:scale-105 transition-all duration-300`; 
    }

    setTxt('detail-desc', data.description || "Información pendiente.");
    setTxt('detail-habitat', data.habitat || "Hábitat no registrado.");
    setTxt('detail-diet', data.dieta || "Dieta desconocida.");
    setTxt('detail-location', data.locationName || "Ubicación oculta");
    setTxt('detail-date', data.encounterDate || "Fecha desconocida");

    modal.classList.remove('hidden');
    lucide.createIcons();

    // 2. Buscar fotos adicionales en Wikimedia Commons
    const extraImages = await fetchCommonsImages(data.scientificName);
    extraImages.forEach((imgUrl, idx) => {
        addSlideToCarousel(imgUrl, 'Wikimedia', false, idx + 1);
    });
    lucide.createIcons();
}

document.getElementById('btn-close-detail')?.addEventListener('click', () => {
    const m = document.getElementById('species-detail-modal'); if (m) m.classList.add('hidden');
});

// Lógica de click en el badge de estado
document.getElementById('detail-status')?.addEventListener('click', (e) => {
    const badge = e.target;
    if (!isStatusExpanded) {
        // Primer click: expandir
        isStatusExpanded = true;
        const info = CONSERVATION_INFO[currentDetailStatus] || CONSERVATION_INFO['UNKNOWN'];
        badge.textContent = `${info.short} - ${info.full}`;
        badge.classList.remove('scale-105');
        badge.classList.add('scale-110');
        setTimeout(() => badge.classList.remove('scale-110'), 200);
    } else {
        // Segundo click: abrir modal
        openConservationModal(currentDetailStatus);
    }
});

function openConservationModal(activeStatus) {
    const listContainer = document.getElementById('conservation-list-container');
    if (!listContainer) return;
    
    listContainer.innerHTML = '';
    
    Object.keys(CONSERVATION_INFO).forEach(key => {
        const info = CONSERVATION_INFO[key];
        const isActive = key === activeStatus;
        
        const card = document.createElement('div');
        card.className = `p-3 rounded-2xl border ${isActive ? 'border-emerald-400 bg-emerald-50 ring-2 ring-emerald-100' : 'border-slate-100 bg-white'} transition-all`;
        
        card.innerHTML = `
            <div class="flex items-center gap-3 mb-1">
                <div class="status-${key} px-2 py-0.5 rounded text-[10px] font-bold shadow-sm border border-black/5 shrink-0">${key}</div>
                <h4 class="font-bold text-sm text-slate-800">${info.full} ${isActive ? '<span class="text-[10px] text-emerald-600 font-normal ml-1 bg-emerald-100 px-1.5 py-0.5 rounded-full">(Tu especie)</span>' : ''}</h4>
            </div>
            <p class="text-xs text-slate-500 ml-12 leading-relaxed">${info.desc}</p>
        `;
        listContainer.appendChild(card);
    });
    
    document.getElementById('conservation-info-modal')?.classList.remove('hidden');
}

document.getElementById('btn-close-conservation')?.addEventListener('click', () => {
    document.getElementById('conservation-info-modal')?.classList.add('hidden');
});

// --- DASHBOARD (HOME) LOGIC ---
let speciesList = [];

async function loadSpeciesOfTheDay() {
    try {
        if (speciesList.length === 0) {
            const res = await fetch('species.json');
            speciesList = await res.json();
        }
        
        // Calculate day of the year (1-366)
        const now = new Date();
        const start = new Date(now.getFullYear(), 0, 0);
        const diff = (now - start) + ((start.getTimezoneOffset() - now.getTimezoneOffset()) * 60 * 1000);
        const oneDay = 1000 * 60 * 60 * 24;
        const dayOfYear = Math.floor(diff / oneDay);
        
        // Get the species for today
        const speciesIndex = (dayOfYear - 1) % speciesList.length;
        const todaySpecies = speciesList[speciesIndex];
        
        // Update Card
        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setTxt('sotd-category', todaySpecies.categoria);
        setTxt('sotd-name', todaySpecies.nombre);
        setTxt('sotd-sci', todaySpecies.cientifico);
        
        // Update Modal
        setTxt('sotd-modal-name', todaySpecies.nombre);
        setTxt('sotd-modal-sci', todaySpecies.cientifico);
        setTxt('sotd-modal-fact', todaySpecies.dato);
        setTxt('sotd-modal-day', `${dayOfYear}/366`);
        
        const btnSearch = document.getElementById('btn-sotd-search');
        if(btnSearch) btnSearch.onclick = () => { window.open(`https://es.wikipedia.org/wiki/${encodeURIComponent(todaySpecies.cientifico)}`, '_blank'); };
        
        // Fetch Image
        const imgs = await fetchCommonsImages(todaySpecies.cientifico);
        if (imgs && imgs.length > 0) {
            const imgEl = document.getElementById('sotd-img');
            const modEl = document.getElementById('sotd-modal-img');
            if(imgEl) imgEl.src = imgs[0];
            if(modEl) modEl.src = imgs[0];
        }
    } catch (e) {
        console.error("Error loading species of the day", e);
    }
}

function updateDashboardStats() {
    if (!globalScans) return;
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt('stat-total-scans', globalScans.length);
    
    const rareCount = globalScans.filter(s => ['NT', 'VU', 'EN', 'CR', 'EW', 'EX'].includes(s.status)).length;
    setTxt('stat-rare', rareCount);
    
    // Mission Progress (3 Missions)
    const todayStr = new Date().toDateString();
    const todayScans = globalScans.filter(s => {
        if(!s.timestamp) return false;
        let d;
        if(s.timestamp.toMillis) d = new Date(s.timestamp.toMillis());
        else if(s.timestamp.seconds) d = new Date(s.timestamp.seconds * 1000);
        else d = new Date();
        return d.toDateString() === todayStr;
    });
    
    // M1: 3 Scans today
    const m1Count = Math.min(todayScans.length, 3);
    const m1Prog = document.getElementById('m1-progress');
    const m1Txt = document.getElementById('m1-text');
    if(m1Prog) m1Prog.style.width = ((m1Count / 3) * 100) + '%';
    if(m1Txt) m1Txt.textContent = `${m1Count}/3`;

    // M2: 1 Rare/Critical species today
    const rareToday = todayScans.filter(s => ['NT', 'VU', 'EN', 'CR', 'EW', 'EX'].includes(s.status)).length;
    const m2Count = Math.min(rareToday, 1);
    const m2Prog = document.getElementById('m2-progress');
    const m2Txt = document.getElementById('m2-text');
    if(m2Prog) m2Prog.style.width = ((m2Count / 1) * 100) + '%';
    if(m2Txt) m2Txt.textContent = `${m2Count}/1`;

    // M3: 100 XP today
    const xpToday = todayScans.reduce((acc, curr) => acc + (curr.xpEarned || 0), 0);
    const m3Count = Math.min(xpToday, 100);
    const m3Prog = document.getElementById('m3-progress');
    const m3Txt = document.getElementById('m3-text');
    if(m3Prog) m3Prog.style.width = ((m3Count / 100) * 100) + '%';
    if(m3Txt) m3Txt.textContent = `${m3Count}/100`;
}

document.getElementById('sotd-card')?.addEventListener('click', () => {
    document.getElementById('sotd-modal')?.classList.remove('hidden');
});

document.getElementById('btn-close-sotd')?.addEventListener('click', () => {
    document.getElementById('sotd-modal')?.classList.add('hidden');
});

// --- CÁMARA (4K & Zoom Support) ---
const btnOpenCamera = document.getElementById('btn-open-camera');
const cameraModal = document.getElementById('camera-modal');
const videoElement = document.getElementById('camera-feed');
const canvasElement = document.getElementById('camera-canvas');
const zoomControls = document.getElementById('zoom-controls');
const zoomLevelText = document.getElementById('zoom-level-text');

async function startCamera() {
    stopCamera();
    try {
        const constraints = { video: { facingMode: currentFacingMode, width: { ideal: 4096 }, height: { ideal: 2160 } } };
        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (videoElement) videoElement.srcObject = cameraStream;
        if (cameraModal) cameraModal.classList.remove('hidden');

        videoTrack = cameraStream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities();

        if (capabilities.zoom && zoomControls) {
            minZoom = capabilities.zoom.min || 1; maxZoom = capabilities.zoom.max || 1;
            currentZoom = minZoom; zoomControls.classList.remove('hidden');
            if (zoomLevelText) zoomLevelText.textContent = currentZoom.toFixed(1) + 'x';
        } else if (zoomControls) { zoomControls.classList.add('hidden'); }
    } catch (err) { console.warn(err); showMessage("Error al abrir la cámara. Verifica los permisos."); }
}

function stopCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(track => track.stop()); if (videoElement) videoElement.srcObject = null; cameraStream = null; videoTrack = null; }
    if (cameraModal) cameraModal.classList.add('hidden');
    if (zoomControls) zoomControls.classList.add('hidden');
}

document.getElementById('btn-zoom-in')?.addEventListener('click', async () => {
    if (videoTrack && currentZoom < maxZoom) {
        const step = (maxZoom - minZoom) > 10 ? 1 : 0.5;
        currentZoom = Math.min(currentZoom + step, maxZoom);
        try {
            await videoTrack.applyConstraints({ advanced: [{ zoom: currentZoom }] });
            if (zoomLevelText) zoomLevelText.textContent = currentZoom.toFixed(1) + 'x';
        } catch (e) { console.error("Error al aplicar zoom", e); }
    }
});

document.getElementById('btn-zoom-out')?.addEventListener('click', async () => {
    if (videoTrack && currentZoom > minZoom) {
        const step = (maxZoom - minZoom) > 10 ? 1 : 0.5;
        currentZoom = Math.max(currentZoom - step, minZoom);
        try {
            await videoTrack.applyConstraints({ advanced: [{ zoom: currentZoom }] });
            if (zoomLevelText) zoomLevelText.textContent = currentZoom.toFixed(1) + 'x';
        } catch (e) { console.error("Error al quitar zoom", e); }
    }
});

btnOpenCamera?.addEventListener('click', () => { if (currentUser) startCamera(); });
document.getElementById('btn-close-camera')?.addEventListener('click', stopCamera);
document.getElementById('btn-flip-camera')?.addEventListener('click', () => { currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment'; startCamera(); });

document.getElementById('btn-capture')?.addEventListener('click', () => {
    if (!cameraStream || !canvasElement || !videoElement) return;
    const flash = document.getElementById('camera-flash');
    if (flash) { flash.style.opacity = '1'; setTimeout(() => flash.style.opacity = '0', 150); }
    canvasElement.width = videoElement.videoWidth; canvasElement.height = videoElement.videoHeight;
    canvasElement.getContext('2d').drawImage(videoElement, 0, 0);
    stopCamera();
    canvasElement.toBlob(blob => processScanFlow(new File([blob], "scan.jpg", { type: "image/jpeg" })), 'image/jpeg', 0.95);
});

// --- Tips Modal Logic ---
function showTipsModal() { const m = document.getElementById('tips-modal'); if (m) m.classList.remove('hidden'); }
document.getElementById('btn-close-tips')?.addEventListener('click', () => { const m = document.getElementById('tips-modal'); if (m) m.classList.add('hidden'); });
document.getElementById('btn-retry-camera')?.addEventListener('click', () => { const m = document.getElementById('tips-modal'); if (m) m.classList.add('hidden'); if (currentUser) startCamera(); });

// --- OBTENER UBICACIÓN ---
async function getReadableLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve("Ubicación no soportada");
        navigator.geolocation.getCurrentPosition(async (pos) => {
            try {
                const { latitude: lat, longitude: lon } = pos.coords;
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`);
                if (!res.ok) throw new Error("API Limit");
                const data = await res.json();
                let locName = "Ubicación desconocida";
                if (data && data.address) {
                    const city = data.address.city || data.address.town || data.address.village || data.address.county || "";
                    const state = data.address.state || data.address.country || "";
                    locName = [city, state].filter(Boolean).join(", ");
                }
                resolve(locName || `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
            } catch (e) { resolve(`${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}`); }
        }, () => { resolve("Ubicación oculta"); }, { timeout: 6000, enableHighAccuracy: false });
    });
}

// --- FLUJO DE ESCANEO ---
async function processScanFlow(file) {
    showLoading("Analizando ADN digital...");
    try {
        const compressedFile = await compressImage(file, 1024);
        
        const statusEl = document.getElementById('loading-status');
        if (statusEl) statusEl.textContent = "Obteniendo ubicación...";
        
        const locationName = await getReadableLocation();

        const formDataWorker = new FormData(); 
        formDataWorker.append('image', compressedFile);
        formDataWorker.append('location', locationName);

        if (statusEl) statusEl.textContent = "Buscando coincidencias...";
        const workerRes = await fetch(WORKER_API_URL, { method: 'POST', body: formDataWorker });

        if (!workerRes.ok) throw new Error("Error de conexión IA");

        const rawAiData = await workerRes.json();
        const safeStatus = (rawAiData.estado && ['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX'].includes(rawAiData.estado.toUpperCase())) ? rawAiData.estado.toUpperCase() : 'UNKNOWN';

        // 1. FILTRO ANTI-UNKNOWN
        if (safeStatus === 'UNKNOWN') {
            hideLoading(); showTipsModal(); return;
        }

        // 2. FILTRO ANTI-DUPLICADOS
        const isDuplicate = globalScans.find(scan => {
            const sciMatch = scan.scientificName && rawAiData.especie && scan.scientificName.toLowerCase() === rawAiData.especie.toLowerCase();
            const nameMatch = scan.name && rawAiData.nombre && scan.name.toLowerCase() === rawAiData.nombre.toLowerCase();
            return sciMatch || nameMatch;
        });

        if (isDuplicate) {
            hideLoading();
            queueAlert({ type: 'duplicate', data: isDuplicate });
            processAlertQueue();
            return; // Detiene el guardado
        }

        if (statusEl) statusEl.textContent = "Descubrimiento verificado. Guardando...";
        const imageId = await uploadToGreenbase(compressedFile);

        const encounterDate = new Date().toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        const aiData = {
            nombre: rawAiData.nombre || "Especie", especie: rawAiData.especie || "Desconocida",
            estado: safeStatus, descripcion: rawAiData.descripcion || "Descripción no generada.",
            habitat: rawAiData.habitat || "Desconocido", dieta: rawAiData.dieta || "Desconocida", categoria: rawAiData.categoria || "Otro",
            locationName: locationName, encounterDate: encounterDate
        };

        await saveAndShowResults(aiData, imageId);
    } catch (error) { hideLoading(); showMessage("Aviso: " + error.message); }
}

function showLoading(text) {
    const desc = document.getElementById('loading-desc'); if (desc) desc.textContent = text;
    const modal = document.getElementById('loading-modal'); if (modal) modal.classList.remove('hidden');
    const bar = document.getElementById('loading-progress');
    if (bar) {
        bar.classList.remove('progress-bar-anim'); bar.style.transition = 'none'; bar.style.width = '0%';
        requestAnimationFrame(() => { requestAnimationFrame(() => { bar.classList.add('progress-bar-anim'); bar.style.width = '95%'; }); });
    }
}

function hideLoading() {
    const bar = document.getElementById('loading-progress');
    if (bar) { bar.style.transition = 'width 0.3s ease-out'; bar.style.width = '100%'; }
    setTimeout(() => { const m = document.getElementById('loading-modal'); if (m) m.classList.add('hidden'); }, 400);
}

async function uploadToGreenbase(file) {
    const formData = new FormData(); formData.append('file', file);
    const res = await fetch('https://greenbase.arielcapdevila.com/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error("Error de red."); return (await res.json()).id;
}

// --- Guardado y Gamificación ---
async function saveAndShowResults(aiData, imageId) {
    const xpGained = XP_REWARDS[aiData.estado] || 0;
    const scansRef = collection(db, 'artifacts', appId, 'users', currentUser.uid, 'scans');
    await setDoc(doc(scansRef), {
        name: aiData.nombre, scientificName: aiData.especie, status: aiData.estado,
        description: aiData.descripcion, habitat: aiData.habitat, dieta: aiData.dieta, categoria: aiData.categoria,
        locationName: aiData.locationName, encounterDate: aiData.encounterDate,
        imageId: imageId, xpEarned: xpGained, timestamp: serverTimestamp()
    });

    if (!currentUserProfile) return hideLoading();
    let newXp = (currentUserProfile.xp || 0) + xpGained;
    let currentAchievements = currentUserProfile.achievements || [];
    let newAchievements = [];

    if (!currentAchievements.includes('first_step')) newAchievements.push('first_step');
    if (['NT', 'VU'].includes(aiData.estado) && !currentAchievements.includes('rare_hunter')) newAchievements.push('rare_hunter');
    if (['CR', 'EW', 'EX'].includes(aiData.estado) && !currentAchievements.includes('critical_hero')) newAchievements.push('critical_hero');
    if (globalScans.length + 1 >= 5 && !currentAchievements.includes('collector_5')) newAchievements.push('collector_5');

    const updatedAchievementsList = [...currentAchievements, ...newAchievements];
    const newLevel = getLevelFromXP(newXp);

    currentUserProfile.xp = newXp; currentUserProfile.level = newLevel; currentUserProfile.achievements = updatedAchievementsList;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leaderboard', currentUser.uid), { xp: newXp, level: newLevel, achievements: updatedAchievementsList });
    updateProfileUI();

    hideLoading();
    queueAlert({ type: 'conservation', data: aiData, xp: xpGained });
    newAchievements.forEach(achId => queueAlert({ type: 'achievement', data: ACHIEVEMENTS_DB[achId] }));
    processAlertQueue();
}

// --- Alertas ---
function queueAlert(alertObj) { pendingAlertsQueue.push(alertObj); }
function processAlertQueue() {
    const alertModal = document.getElementById('alert-modal'); const achModal = document.getElementById('achievement-modal');
    if (pendingAlertsQueue.length === 0 || (alertModal && !alertModal.classList.contains('hidden')) || (achModal && !achModal.classList.contains('hidden'))) return;
    const next = pendingAlertsQueue.shift();
    if (next.type === 'conservation') showConservationAlert(next.data, next.xp);
    else if (next.type === 'achievement') showAchievementAlert(next.data);
    else if (next.type === 'duplicate') showDuplicateAlert(next.data);
}

function resetAlertStyles() {
    const xpGain = document.getElementById('alert-xp-gain');
    if (xpGain) xpGain.className = "text-emerald-600 font-bold text-base mb-4 bg-emerald-50 inline-block px-4 py-1 rounded-full";
    const btnClose = document.getElementById('btn-close-alert');
    if (btnClose) btnClose.textContent = "Añadir a Colección";
}

function showConservationAlert(data, xp) {
    const modal = document.getElementById('alert-modal'); const card = document.getElementById('alert-card');
    const isCritical = ['EN', 'CR', 'EW', 'EX'].includes(data.estado);

    if (modal) modal.classList.remove('hidden');
    resetAlertStyles();

    const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setTxt('alert-species', data.nombre); setTxt('alert-habitat', data.habitat); setTxt('alert-category', data.categoria);
    setTxt('alert-location', data.locationName); setTxt('alert-date', data.encounterDate);

    const statusBadge = document.getElementById('alert-status-badge');
    if (statusBadge) { statusBadge.textContent = data.estado; statusBadge.className = `inline-block px-4 py-1 rounded-full font-bold text-xs mb-3 shadow-sm border border-black/10 status-${data.estado}`; }

    const xpGain = document.getElementById('alert-xp-gain');
    if (xpGain) xpGain.textContent = `+${xp} XP Conseguidos`;

    const iconContainer = document.getElementById('alert-icon-container'); const alertIcon = document.getElementById('alert-icon');
    const alertTitle = document.getElementById('alert-title'); const alertMsg = document.getElementById('alert-message');

    if (!isCritical && data.estado !== 'UNKNOWN' && data.estado !== 'LC') {
        if (card) card.className = 'bg-white p-6 sm:p-8 rounded-3xl shadow-2xl max-w-md w-full text-center alert-rare border border-yellow-200';
        if (iconContainer) iconContainer.className = 'w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4 bg-yellow-100 text-yellow-600 shadow-inner';
        if (alertIcon) alertIcon.setAttribute('data-lucide', 'sparkles');
        if (alertTitle) { alertTitle.textContent = '✨ RAREZA ✨'; alertTitle.className = 'text-2xl font-outfit font-bold mb-1 tracking-wide text-yellow-600'; }
        if (alertMsg) alertMsg.textContent = data.descripcion;
    } else if (isCritical) {
        if (card) card.className = 'bg-white p-6 sm:p-8 rounded-3xl shadow-2xl max-w-md w-full text-center alert-critical border border-red-200';
        if (iconContainer) iconContainer.className = 'w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4 bg-red-100 text-red-600 shadow-inner';
        if (alertIcon) alertIcon.setAttribute('data-lucide', 'alert-triangle');
        if (alertTitle) { alertTitle.textContent = '⚠️ CRÍTICO ⚠️'; alertTitle.className = 'text-2xl font-outfit font-bold mb-1 tracking-wide text-red-600'; }
        if (alertMsg) alertMsg.textContent = data.descripcion;
    } else {
        if (card) card.className = 'bg-white p-6 sm:p-8 rounded-3xl shadow-2xl max-w-md w-full text-center transform transition-all border border-slate-100';
        if (iconContainer) iconContainer.className = 'w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4 bg-emerald-100 text-emerald-600 shadow-inner';
        if (alertIcon) alertIcon.setAttribute('data-lucide', 'check-circle');
        if (alertTitle) { alertTitle.textContent = 'REGISTRO NUEVO'; alertTitle.className = 'text-2xl font-outfit font-bold mb-1 tracking-wide text-slate-800'; }
        if (alertMsg) alertMsg.textContent = data.descripcion;
    }
    lucide.createIcons(); playAudio(isCritical ? 'critical' : (data.estado !== 'LC' && data.estado !== 'UNKNOWN' ? 'rare' : 'normal'));
}

function showDuplicateAlert(existingData) {
    const modal = document.getElementById('alert-modal'); const card = document.getElementById('alert-card');
    if (modal) modal.classList.remove('hidden');

    const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setTxt('alert-species', existingData.name || 'Especie'); setTxt('alert-habitat', existingData.habitat || '?'); setTxt('alert-category', existingData.categoria || 'Otro');
    setTxt('alert-location', existingData.locationName || 'Ubicación oculta'); setTxt('alert-date', existingData.encounterDate || 'Desconocida');

    const statusBadge = document.getElementById('alert-status-badge');
    if (statusBadge) { statusBadge.textContent = existingData.status; statusBadge.className = `inline-block px-4 py-1 rounded-full font-bold text-xs mb-3 shadow-sm border border-black/10 status-${existingData.status}`; }

    const xpGain = document.getElementById('alert-xp-gain');
    if (xpGain) { xpGain.textContent = `Ya registrada`; xpGain.className = "text-slate-500 font-bold text-base mb-4 bg-slate-100 inline-block px-4 py-1 rounded-full"; }

    const iconContainer = document.getElementById('alert-icon-container'); const alertIcon = document.getElementById('alert-icon');
    const alertTitle = document.getElementById('alert-title'); const alertMsg = document.getElementById('alert-message');

    if (card) card.className = 'bg-white p-6 sm:p-8 rounded-3xl shadow-2xl max-w-md w-full text-center transform transition-all border border-blue-200';
    if (iconContainer) iconContainer.className = 'w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4 bg-blue-100 text-blue-600 shadow-inner';
    if (alertIcon) alertIcon.setAttribute('data-lucide', 'book-check');
    if (alertTitle) { alertTitle.textContent = '¡YA LA TIENES!'; alertTitle.className = 'text-2xl font-outfit font-bold mb-1 tracking-wide text-blue-600'; }
    if (alertMsg) alertMsg.textContent = existingData.description;

    const btnClose = document.getElementById('btn-close-alert');
    if (btnClose) btnClose.textContent = "Entendido";

    lucide.createIcons(); playAudio('normal');
}

function showAchievementAlert(achData) {
    const modal = document.getElementById('achievement-modal');
    if (modal) { modal.classList.remove('hidden'); const popDiv = modal.querySelector('.achievement-pop'); if (popDiv) { popDiv.style.animation = 'none'; popDiv.offsetHeight; popDiv.style.animation = null; } }
    const icon = document.getElementById('ach-modal-icon'); if (icon) icon.setAttribute('data-lucide', achData.icon);
    const title = document.getElementById('ach-modal-title'); if (title) title.textContent = achData.title;
    const desc = document.getElementById('ach-modal-desc'); if (desc) desc.textContent = achData.desc;
    lucide.createIcons(); playAudio('achievement');
}

document.getElementById('btn-close-alert')?.addEventListener('click', () => { const m = document.getElementById('alert-modal'); if (m) m.classList.add('hidden'); setTimeout(processAlertQueue, 300); });
document.getElementById('btn-close-ach')?.addEventListener('click', () => { const m = document.getElementById('achievement-modal'); if (m) m.classList.add('hidden'); setTimeout(processAlertQueue, 300); });

// Utilidades
function compressImage(file, maxSize) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image(); img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas'); let w = img.width, h = img.height;
                if (w > h && w > maxSize) { h *= maxSize / w; w = maxSize; } else if (h > maxSize) { w *= maxSize / h; h = maxSize; }
                canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                canvas.toBlob(b => resolve(new File([b], file.name, { type: 'image/jpeg' })), 'image/jpeg', 0.85);
            };
        };
        reader.onerror = error => reject(error);
    });
}
function showMessage(msg) {
    const toast = document.createElement('div'); toast.className = 'fixed top-20 left-1/2 transform -translate-x-1/2 bg-slate-800 text-white px-6 py-3 rounded-full shadow-lg z-[300] font-medium text-sm transition-opacity duration-300';
    toast.textContent = msg; document.body.appendChild(toast); setTimeout(() => { toast.classList.add('opacity-0'); setTimeout(() => toast.remove(), 300); }, 3000);
}

document.getElementById('avatar-container')?.addEventListener('click', () => { if (currentUser) document.getElementById('pfp-input')?.click(); });
document.getElementById('pfp-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return; showLoading("Actualizando avatar...");
    const input = document.getElementById('pfp-input'); if (input) input.value = '';
    try {
        const compFile = await compressImage(file, 400); const imageId = await uploadToGreenbase(compFile);
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leaderboard', currentUser.uid), { photoId: imageId });
        hideLoading(); showMessage("Avatar actualizado");
    } catch (err) { hideLoading(); showMessage("Error al actualizar"); }
});

// Audio
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playTone(freq, type, duration, vol, delay = 0) {
    setTimeout(() => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.type = type; osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
        osc.connect(gain); gain.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + duration);
    }, delay);
}
function playAudio(type) {
    if (type === 'rare') { playTone(523.25, 'sine', 0.5, 0.4); playTone(659.25, 'sine', 0.5, 0.4, 150); playTone(783.99, 'sine', 0.8, 0.4, 300); }
    else if (type === 'critical') { [0, 400, 800].forEach(d => playTone(300, 'sawtooth', 0.3, 0.3, d)); }
    else if (type === 'achievement') { playTone(440, 'square', 0.1, 0.2); playTone(554.37, 'square', 0.1, 0.2, 100); playTone(659.25, 'square', 0.4, 0.2, 200); }
    else if (type === 'normal') { playTone(440, 'sine', 0.2, 0.3); playTone(554, 'sine', 0.3, 0.3, 100); }
}

// --- Banner de Instalación PWA ---
let deferredPrompt;
const installBanner = document.getElementById('pwa-install-banner');
const btnInstall = document.getElementById('btn-install-pwa');
const btnCloseBanner = document.getElementById('btn-close-pwa-banner');

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

function checkShowBanner() {
    if (window.innerWidth < 768 && !isStandalone && !localStorage.getItem('pwa-banner-dismissed')) {
        installBanner?.classList.remove('hidden');
        installBanner?.classList.add('flex');
    }
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    checkShowBanner();
});

// Soporte manual para iOS (que no dispara beforeinstallprompt)
if (isIOS) {
    checkShowBanner();
    btnInstall?.addEventListener('click', () => {
        alert("Para instalar en iOS:\nToca el icono 'Compartir' en la barra inferior de Safari y luego selecciona 'Añadir a la pantalla de inicio'.");
    });
} else {
    btnInstall?.addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') {
                installBanner?.classList.add('hidden');
                installBanner?.classList.remove('flex');
            }
            deferredPrompt = null;
        }
    });
}

btnCloseBanner?.addEventListener('click', () => {
    installBanner?.classList.add('hidden');
    installBanner?.classList.remove('flex');
    localStorage.setItem('pwa-banner-dismissed', 'true');
});

window.addEventListener('appinstalled', () => {
    installBanner?.classList.add('hidden');
    installBanner?.classList.remove('flex');
    deferredPrompt = null;
});

// --- GALLERY ---
function renderGallery(scans) {
    const grid = document.getElementById('gallery-grid');
    const empty = document.getElementById('gallery-empty-state');
    if (!grid || !empty) return;
    grid.innerHTML = '';
    const validScans = scans.filter(s => s.imageId);
    if (validScans.length === 0) {
        empty.classList.remove('hidden'); empty.classList.add('flex');
    } else {
        empty.classList.add('hidden'); empty.classList.remove('flex');
        validScans.forEach((data) => {
            const imgUrl = `https://greenbase.arielcapdevila.com/file/${data.imageId}`;
            const card = document.createElement('div');
            card.className = 'glass-card rounded-2xl overflow-hidden shadow-sm relative group cursor-pointer border border-slate-100 aspect-square';
            card.innerHTML = `
                <img src="${imgUrl}" alt="${data.name}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110">
                <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                    <p class="text-white font-bold text-xs truncate drop-shadow-md mb-1">${data.name || 'Desconocido'}</p>
                    <button class="btn-download absolute top-2 right-2 bg-white/20 hover:bg-emerald-500 text-white backdrop-blur rounded-full p-2 transition-colors shadow-lg flex items-center justify-center" data-url="${imgUrl}" data-name="${data.name || 'foto'}.jpg" title="Descargar">
                        <i data-lucide="download" class="w-4 h-4"></i>
                    </button>
                </div>
            `;
            // Click on image opens detail modal, except if downloading
            card.addEventListener('click', (e) => {
                if(e.target.closest('.btn-download')) {
                    downloadImage(imgUrl, `${data.name || 'foto'}.jpg`);
                } else {
                    openSpeciesDetail(data);
                }
            });
            grid.appendChild(card);
        });
        lucide.createIcons();
    }
}

async function downloadImage(url, filename) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
    } catch (e) {
        window.open(url, '_blank');
    }
}

// --- CROPPER LOGIC ---
let currentCropper = null;
const cropModal = document.getElementById('crop-modal');
const cropImageEl = document.getElementById('crop-image-element');
const fileInput = document.getElementById('upload-photo-input');

function setupUploadButtons() {
    ['btn-header-upload', 'btn-camera-upload'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => {
            if (currentUser) {
                fileInput.click();
            } else {
                showMessage("Inicia sesión para subir fotos");
            }
        });
    });
}
setupUploadButtons();

fileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    if(cropImageEl) cropImageEl.src = url;
    
    // Stop camera if it's open
    stopCamera();
    
    if(cropModal) cropModal.classList.remove('hidden');
    
    if (currentCropper) {
        currentCropper.destroy();
    }
    
    if(cropImageEl) {
        cropImageEl.onload = () => {
            currentCropper = new Cropper(cropImageEl, {
                viewMode: 1,
                autoCropArea: 0.9,
                responsive: true,
                background: false,
            });
        };
    }
    fileInput.value = ''; // reset
});

document.getElementById('btn-cancel-crop')?.addEventListener('click', () => {
    if(cropModal) cropModal.classList.add('hidden');
    if (currentCropper) currentCropper.destroy();
});

document.getElementById('btn-rotate-crop')?.addEventListener('click', () => {
    if (currentCropper) currentCropper.rotate(90);
});

document.getElementById('btn-confirm-crop')?.addEventListener('click', () => {
    if (!currentCropper) return;
    const canvas = currentCropper.getCroppedCanvas({
        maxWidth: 2048,
        maxHeight: 2048
    });
    if (!canvas) return;
    
    if(cropModal) cropModal.classList.add('hidden');
    currentCropper.destroy();
    
    canvas.toBlob((blob) => {
        const croppedFile = new File([blob], "upload.jpg", { type: 'image/jpeg' });
        processScanFlow(croppedFile);
    }, 'image/jpeg', 0.9);
});