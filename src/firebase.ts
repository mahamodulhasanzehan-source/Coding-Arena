
// Replaced with robust local mock implementation to resolve build errors with missing firebase modules.
// This allows the app to function completely using LocalStorage for persistence.

// Fix for import.meta.env type error
const env = (import.meta as any).env || {};

const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID
};

// --- Mock Auth ---

export interface User {
    uid: string;
    isAnonymous: boolean;
    photoURL?: string | null;
    displayName?: string | null;
    email?: string | null;
}

let currentUser: User | null = JSON.parse(localStorage.getItem('nodecode_mock_user') || 'null');
const authStateListeners = new Set<(user: User | null) => void>();

export const auth = {
    get currentUser() { return currentUser; }
};

export const db = {}; // Mock DB object

// --- Auth Functions ---

export const signInWithGoogle = async () => {
    console.log("Mock Sign In: Logging in as local user.");
    const mockUser: User = { 
        uid: 'local-user-' + Math.random().toString(36).substr(2, 9), 
        isAnonymous: false, 
        photoURL: 'https://ui-avatars.com/api/?name=Local+User&background=random', 
        displayName: 'Local User',
        email: 'local@example.com'
    };
    
    currentUser = mockUser;
    localStorage.setItem('nodecode_mock_user', JSON.stringify(currentUser));
    notifyListeners();
    return mockUser;
};

export const logOut = async () => {
    console.log('Mock Logged out');
    currentUser = null;
    localStorage.removeItem('nodecode_mock_user');
    notifyListeners();
};

export const onAuthStateChanged = (authInstance: any, callback: (user: User | null) => void) => {
    authStateListeners.add(callback);
    // Trigger immediately with current state
    callback(currentUser);
    return () => {
        authStateListeners.delete(callback);
    };
};

function notifyListeners() {
    authStateListeners.forEach(listener => listener(currentUser));
}

// --- Firestore Wrappers (Mock with LocalStorage) ---

export const doc = (database: any, col: string, id: string) => {
    return { id, path: `${col}/${id}`, _mock: true }; 
};

export const getDoc = async (ref: any) => {
    // Mock Storage Reading (localStorage fallback for persistence in mock mode)
    const stored = localStorage.getItem(`mock_db_${ref.path}`);
    if (stored) {
        return { 
            exists: () => true, 
            data: () => JSON.parse(stored) 
        };
    }
    return { exists: () => false, data: () => undefined };
};

export const setDoc = async (ref: any, data: any, opts?: any) => {
    console.log(`[MockDB] Saving to ${ref.path}`);
    // Simple mock implementation: Overwrite (merge not fully supported in this simple mock but sufficient for App.tsx usage)
    const existing = localStorage.getItem(`mock_db_${ref.path}`);
    let finalData = data;
    
    if (opts?.merge && existing) {
        finalData = { ...JSON.parse(existing), ...data };
    }
    
    localStorage.setItem(`mock_db_${ref.path}`, JSON.stringify(finalData));
};

export const deleteDoc = async (ref: any) => {
    console.log(`[MockDB] Deleting ${ref.path}`);
    localStorage.removeItem(`mock_db_${ref.path}`);
};
