import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the `VITE_` prefix.
  const env = loadEnv(mode, (process as any).cwd(), '');
  return {
    plugins: [react()],
    define: {
      // JSON.stringify is needed to wrap the value in quotes for replacement
      // Map GEMINI_API_KEY_4 to API_KEY to comply with @google/genai guidelines
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY_4 || env.API_KEY || ''),
      'process.env.GEMINI_API_KEY_4': JSON.stringify(env.GEMINI_API_KEY_4),
      'process.env.GEMINI_API_KEY_5': JSON.stringify(env.GEMINI_API_KEY_5),
    }
  }
})