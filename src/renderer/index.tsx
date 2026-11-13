import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';

// No StrictMode: its double-mount would open every SSH session twice in development.
createRoot(document.getElementById('root')!).render(<App />);
