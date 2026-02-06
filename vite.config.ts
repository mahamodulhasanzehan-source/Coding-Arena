
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Cast process to any to avoid TypeScript error: Property 'cwd' does not exist on type 'Process'.
  const env = loadEnv(mode, (process as any).cwd(), '');
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './'),
      },
    },
    define: {
      // JSON.stringify is needed to wrap the value in quotes for replacement
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY_4 || env.API_KEY || ''),
      'process.env.GEMINI_API_KEY_4': JSON.stringify(env.GEMINI_API_KEY_4),
      'process.env.GEMINI_API_KEY_5': JSON.stringify(env.GEMINI_API_KEY_5),
    },
    build: {
      rollupOptions: {
        // markdown-to-jsx removed from external to ensure it is bundled with the local React version
        external: []
      }
    }
  }
})
