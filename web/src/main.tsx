import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root not found');
createRoot(root).render(<App />);
