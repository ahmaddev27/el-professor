import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { designPreviewEnabled } from './src/design-preview/buildFlag';

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // Includes process.env, where CI puts VITE_DEPLOY_ENV for a staging build.
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
    plugins: [react()],
    define: {
      // false in production builds: App.tsx's lazy import of the design preview
      // folds to null and none of the preview's code is emitted. PR checks and
      // the production deploy both grep the bundle to prove it.
      __DESIGN_PREVIEW__: JSON.stringify(designPreviewEnabled(command, env.VITE_DEPLOY_ENV)),
    },
    optimizeDeps: {
      exclude: ['lucide-react'],
      include: ['html2canvas'],
    },
  };
});
