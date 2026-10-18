import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
