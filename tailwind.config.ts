import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        desk: {
          ink: '#0f2744',
          blue: '#1a4f8b',
          teal: '#0c8f84',
          amber: '#f2b544',
          coral: '#d4534a',
        },
      },
    },
  },
  plugins: [],
};

export default config;
