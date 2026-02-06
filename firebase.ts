
// Mock implementation to replace missing firebase module and fix build errors
export const auth = {
  currentUser: { uid: 'local-user', isAnonymous: true, photoURL: null }
};

export const db = {};

export const signIn = async () => {
  return { uid: 'local-user', isAnonymous: true };
};

export const signInWithGoogle = async () => {
  return { uid: 'local-user', isAnonymous: false, photoURL: null };
};

export const logOut = async () => {
  console.log('Logged out');
};

export const onAuthStateChanged = (authInstance: any, callback: (user: any) => void) => {
    // Simulate auth state change immediately
    const user = { uid: 'local-user', isAnonymous: true, photoURL: null };
    callback(user);
    return () => {};
};

export interface User {
    uid: string;
    isAnonymous: boolean;
    photoURL?: string | null;
}
