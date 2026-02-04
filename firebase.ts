
import { initializeApp } from "firebase/app";
// @ts-ignore
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBllwH83gpDoLAeo_XnnMDu4mmWVzBJOkA",
  authDomain: "tacotyper.firebaseapp.com",
  projectId: "tacotyper",
  storageBucket: "tacotyper.firebasestorage.app",
  messagingSenderId: "781290974991",
  appId: "1:781290974991:web:9be3718a10fc11c9a5187a",
  measurementId: "G-P0VZGCB036"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const signIn = async () => {
  try {
    const userCredential = await signInAnonymously(auth);
    return userCredential.user;
  } catch (error) {
    console.error("Error signing in anonymously:", error);
    throw error;
  }
};
