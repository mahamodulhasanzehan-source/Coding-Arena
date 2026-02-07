
export const auth = {
  currentUser: { uid: 'local-user', isAnonymous: true, photoURL: null, displayName: 'Local User' }
};

export const db = {};

export const signInWithGoogle = async () => {
  return { uid: 'local-user', isAnonymous: false, photoURL: null, displayName: 'Local User' };
};

export const logOut = async () => {
  console.log('Logged out');
};

export const onAuthStateChanged = (authInstance: any, callback: (user: any) => void) => {
    // Simulate auth state change immediately
    const user = { uid: 'local-user', isAnonymous: true, photoURL: null, displayName: 'Local User' };
    callback(user);
    return () => {};
};

// Mock Firestore functions
export const doc = (db: any, col: string, id: string) => ({});
export const getDoc = async (ref: any) => ({ exists: () => false, data: () => ({}) });
export const setDoc = async (ref: any, data: any, opts?: any) => {};
export const deleteDoc = async (ref: any) => {};

export interface User {
    uid: string;
    isAnonymous: boolean;
    photoURL?: string | null;
    displayName?: string | null;
}
