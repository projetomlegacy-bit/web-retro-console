import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Safely catch permissions issues with screen-wake-lock API inside development iframe environments
if (typeof navigator !== 'undefined' && navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
  const originalWakeLockLock = navigator.wakeLock.request;
  navigator.wakeLock.request = async function (this: any, type: string) {
    try {
      return await originalWakeLockLock.call(this, type);
    } catch (err) {
      console.warn('[WakeLock] Intercepted blocked wake-lock permission policy request inside sandbox iframe:', err);
      return {
        released: false,
        type,
        release: async () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      } as any;
    }
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
