import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './style.css';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('页面缺少 #root 容器。');

createRoot(root).render(<App />);
