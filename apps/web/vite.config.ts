import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4300',
      '/health': 'http://localhost:4300',
      '/socket.io': {
        target: 'ws://localhost:4300',
        ws: true,
      },
    },
  },
});
